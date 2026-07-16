import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import globalize from 'lib/globalize';

const COLLECTION_TYPE_DISPLAY_KEYS: Partial<Record<CollectionType, string>> = {
    [CollectionType.Books]: 'Books',
    [CollectionType.Boxsets]: 'Collections',
    [CollectionType.Folders]: 'Folders',
    [CollectionType.Homevideos]: 'HeaderVideos',
    [CollectionType.Livetv]: 'LiveTV',
    [CollectionType.Movies]: 'Movies',
    [CollectionType.Music]: 'TabMusic',
    [CollectionType.Musicvideos]: 'MusicVideos',
    [CollectionType.Photos]: 'Photos',
    [CollectionType.Playlists]: 'Playlists',
    [CollectionType.Trailers]: 'Trailers',
    [CollectionType.Tvshows]: 'Shows',
    [CollectionType.Unknown]: 'Folders'
};

export function getLibraryDisplayName(item: BaseItemDto): string {
    const itemName = item.Name?.trim();
    if (itemName) {
        return item.Name || itemName;
    }

    const displayKey = item.CollectionType ?
        COLLECTION_TYPE_DISPLAY_KEYS[item.CollectionType] :
        undefined;

    return displayKey ? globalize.translate(displayKey) : '';
}

export function withLibraryDisplayNames(items: BaseItemDto[]): BaseItemDto[] {
    return items.map(item => {
        if (item.Name?.trim()) {
            return item;
        }

        const displayName = getLibraryDisplayName(item);
        return displayName ? {
            ...item,
            Name: displayName
        } : item;
    });
}
