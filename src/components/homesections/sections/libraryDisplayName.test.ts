import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { describe, expect, it, vi } from 'vitest';

import {
    getLibraryDisplayName,
    withLibraryDisplayNames
} from './libraryDisplayName';

vi.mock('lib/globalize', () => ({
    default: {
        translate: (key: string) => `translated:${key}`
    }
}));

describe('getLibraryDisplayName()', () => {
    it('preserves an existing library name', () => {
        expect(getLibraryDisplayName({
            Name: 'My Tunes',
            CollectionType: CollectionType.Music
        } as BaseItemDto)).toBe('My Tunes');
    });

    it('falls back to the music translation when the music library name is empty', () => {
        expect(getLibraryDisplayName({
            Name: '',
            CollectionType: CollectionType.Music
        } as BaseItemDto)).toBe('translated:TabMusic');
    });

    it('falls back to the collections translation for box sets libraries', () => {
        expect(getLibraryDisplayName({
            CollectionType: CollectionType.Boxsets
        } as BaseItemDto)).toBe('translated:Collections');
    });
});

describe('withLibraryDisplayNames()', () => {
    it('fills missing collection folder names without changing named items', () => {
        const named = {
            Name: 'Movies',
            CollectionType: CollectionType.Movies
        } as BaseItemDto;
        const unnamedMusic = {
            Name: ' ',
            CollectionType: CollectionType.Music
        } as BaseItemDto;

        expect(withLibraryDisplayNames([ named, unnamedMusic ])).toEqual([
            named,
            {
                ...unnamedMusic,
                Name: 'translated:TabMusic'
            }
        ]);
    });
});
