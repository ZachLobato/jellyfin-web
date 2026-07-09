import { HomeSectionType } from 'constants/homeSectionType';

import type { SectionOptions } from 'components/homesections/sections/section';

const customHomeSections = {
    wrapMyMedia: true,
    hideRecentlyAdded: true,
    hideNextUp: true,
    combineContinueSections: true
};

const continueSectionTypes = [
    HomeSectionType.Resume,
    HomeSectionType.ResumeAudio,
    HomeSectionType.ResumeBook
];

export function shouldCombineContinueSections(): boolean {
    return customHomeSections.combineContinueSections;
}

export function getCustomizedHomeSections(sections: HomeSectionType[]): HomeSectionType[] {
    if (!customHomeSections.combineContinueSections) {
        return sections;
    }

    let hasCombinedContinueSection = false;
    return sections.map(section => {
        if (!continueSectionTypes.includes(section)) {
            return section;
        }

        if (hasCombinedContinueSection) {
            return HomeSectionType.None;
        }

        hasCombinedContinueSection = true;
        return HomeSectionType.Resume;
    });
}

export function shouldHideHomeSection(section: HomeSectionType): boolean {
    return (customHomeSections.hideRecentlyAdded && section === HomeSectionType.LatestMedia)
        || (customHomeSections.hideNextUp && section === HomeSectionType.NextUp);
}

export function getHomeSectionOptions(section: HomeSectionType): SectionOptions {
    return {
        enableOverflow: !(customHomeSections.wrapMyMedia
            && section === HomeSectionType.SmallLibraryTiles)
    };
}
