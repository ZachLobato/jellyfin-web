import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import type { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import type { ApiClient } from 'jellyfin-apiclient';

import { getResumeItemsQuery } from 'apps/legacy/features/libraries/api/useResumeItems';
import cardBuilder from 'components/cardbuilder/cardBuilder';
import { getBackdropShape, getPortraitShape, getSquareShape } from 'components/cardbuilder/utils/shape';
import globalize from 'lib/globalize';
import ServerConnections from 'lib/jellyfin-apiclient/ServerConnections';
import { queryClient } from 'utils/query/queryClient';
import type { UserSettings } from 'scripts/settings/userSettings';

import type { SectionContainerElement, SectionOptions } from './section';

const dataMonitorHints: Record<string, string> = {
    Audio: 'audioplayback,markplayed',
    Video: 'videoplayback,markplayed'
};

const combinedResumeMediaTypes: MediaType[] = [
    'Video',
    'Audio',
    'Book'
];

function getItemsToResumeFn(
    apiClient: ApiClient,
    mediaType: MediaType,
    { enableOverflow }: SectionOptions
) {
    return function () {
        const api = ServerConnections.getApi(apiClient.serverId());
        const limit = enableOverflow ? 12 : 5;

        const options = {
            userId: apiClient.getCurrentUserId(),
            limit,
            fields: [ ItemFields.PrimaryImageAspectRatio ],
            imageTypeLimit: 1,
            enableImageTypes: [
                ImageType.Primary,
                ImageType.Backdrop,
                ImageType.Thumb
            ],
            enableTotalRecordCount: false,
            mediaTypes: [ mediaType ]
        };

        return queryClient
            .fetchQuery(getResumeItemsQuery(api, options));
    };
}

function getResumeItemTimestamp(item: BaseItemDto): number {
    const lastPlayedDate = item.UserData?.LastPlayedDate;
    return lastPlayedDate ? new Date(lastPlayedDate).getTime() : 0;
}

function getCombinedItemsToResumeFn(
    apiClient: ApiClient,
    { enableOverflow }: SectionOptions
) {
    return function () {
        const api = ServerConnections.getApi(apiClient.serverId());
        const limit = enableOverflow ? 12 : 5;

        const fetches = combinedResumeMediaTypes.map(mediaType => {
            const options = {
                userId: apiClient.getCurrentUserId(),
                limit,
                fields: [ ItemFields.PrimaryImageAspectRatio ],
                imageTypeLimit: 1,
                enableImageTypes: [
                    ImageType.Primary,
                    ImageType.Backdrop,
                    ImageType.Thumb
                ],
                enableTotalRecordCount: false,
                mediaTypes: [ mediaType ]
            };

            return queryClient
                .fetchQuery(getResumeItemsQuery(api, options));
        });

        return Promise.all(fetches)
            .then(results => results
                .reduce<BaseItemDto[]>((items, result) => items.concat(result.Items ?? []), [])
                .map((item, index) => ({ item, index }))
                .sort((a, b) => (
                    getResumeItemTimestamp(b.item) - getResumeItemTimestamp(a.item)
                    || a.index - b.index
                ))
                .slice(0, limit)
                .map(({ item }) => item));
    };
}

function getResumeCardShape(item: BaseItemDto, enableOverflow: boolean) {
    if (item.MediaType === 'Audio') {
        return getSquareShape(enableOverflow);
    }

    if (item.MediaType === 'Book') {
        return getPortraitShape(enableOverflow);
    }

    return getBackdropShape(enableOverflow);
}

function getItemsToResumeHtmlFn(
    useEpisodeImages: boolean,
    mediaType: MediaType,
    { enableOverflow }: SectionOptions
) {
    return function (items: BaseItemDto[]) {
        const cardLayout = false;
        return cardBuilder.getCardsHtml({
            items: items,
            preferThumb: true,
            inheritThumb: !useEpisodeImages,
            shape: (mediaType === 'Book') ?
                getPortraitShape(enableOverflow) :
                getBackdropShape(enableOverflow),
            overlayText: false,
            showTitle: true,
            showParentTitle: true,
            lazy: true,
            showDetailsMenu: true,
            overlayPlayButton: true,
            context: 'home',
            centerText: !cardLayout,
            allowBottomPadding: false,
            cardLayout: cardLayout,
            showYear: true,
            lines: 2
        });
    };
}

function getCombinedItemsToResumeHtmlFn(
    useEpisodeImages: boolean,
    { enableOverflow }: SectionOptions
) {
    return function (items: BaseItemDto[]) {
        const cardLayout = false;
        return items.map(item => cardBuilder.getCardsHtml({
            items: [ item ],
            preferThumb: item.MediaType === 'Video',
            inheritThumb: item.MediaType === 'Video' && !useEpisodeImages,
            shape: getResumeCardShape(item, enableOverflow),
            overlayText: false,
            showTitle: true,
            showParentTitle: true,
            lazy: true,
            showDetailsMenu: true,
            overlayPlayButton: true,
            context: 'home',
            centerText: !cardLayout,
            allowBottomPadding: false,
            cardLayout: cardLayout,
            showYear: item.MediaType !== 'Audio',
            lines: 2,
            coverImage: item.MediaType === 'Audio'
        })).join('');
    };
}

export function loadResume(
    elem: HTMLElement,
    apiClient: ApiClient,
    titleLabel: string,
    mediaType: MediaType,
    userSettings: UserSettings,
    options: SectionOptions
) {
    let html = '';

    const dataMonitor = dataMonitorHints[mediaType] ?? 'markplayed';

    html += '<h2 class="sectionTitle sectionTitle-cards padded-left">' + globalize.translate(titleLabel) + '</h2>';
    if (options.enableOverflow) {
        html += '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">';
        html += `<div is="emby-itemscontainer" class="itemsContainer scrollSlider focuscontainer-x" data-monitor="${dataMonitor}">`;
    } else {
        html += `<div is="emby-itemscontainer" class="itemsContainer padded-left padded-right vertical-wrap focuscontainer-x" data-monitor="${dataMonitor}">`;
    }

    if (options.enableOverflow) {
        html += '</div>';
    }
    html += '</div>';

    elem.classList.add('hide');
    elem.innerHTML = html;

    const itemsContainer: SectionContainerElement | null = elem.querySelector('.itemsContainer');
    if (!itemsContainer) return;
    itemsContainer.fetchData = getItemsToResumeFn(apiClient, mediaType, options);
    itemsContainer.getItemsHtml = getItemsToResumeHtmlFn(userSettings.useEpisodeImagesInNextUpAndResume(), mediaType, options);
    itemsContainer.parentContainer = elem;
}

export function loadCombinedResume(
    elem: HTMLElement,
    apiClient: ApiClient,
    userSettings: UserSettings,
    options: SectionOptions
) {
    let html = '';

    html += '<h2 class="sectionTitle sectionTitle-cards padded-left">Continue</h2>';
    if (options.enableOverflow) {
        html += '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">';
        html += '<div is="emby-itemscontainer" class="itemsContainer combinedResumeItems scrollSlider focuscontainer-x" data-monitor="videoplayback,audioplayback,markplayed">';
    } else {
        html += '<div is="emby-itemscontainer" class="itemsContainer combinedResumeItems padded-left padded-right vertical-wrap focuscontainer-x" data-monitor="videoplayback,audioplayback,markplayed">';
    }

    if (options.enableOverflow) {
        html += '</div>';
    }
    html += '</div>';

    elem.classList.add('hide');
    elem.innerHTML = html;

    const itemsContainer: SectionContainerElement | null = elem.querySelector('.itemsContainer');
    if (!itemsContainer) return;
    itemsContainer.fetchData = getCombinedItemsToResumeFn(apiClient, options);
    itemsContainer.getItemsHtml = getCombinedItemsToResumeHtmlFn(userSettings.useEpisodeImagesInNextUpAndResume(), options);
    itemsContainer.parentContainer = elem;
}
