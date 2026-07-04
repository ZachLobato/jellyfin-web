import { describe, expect, it } from 'vitest';

import {
    getTtsWsUrl,
    isLocalTtsHost,
    normalizeSpeechText,
    prepareTextForSentenceSplit
} from './ttsReader';

describe('prepareTextForSentenceSplit', () => {
    it('protects dotted numeric dates from sentence splitting', () => {
        const text = '* 1.5.1735 | 22.5.1819 The admiral';

        expect(prepareTextForSentenceSplit(text))
            .toBe('* 1/5/1735 | 22/5/1819 The admiral');
    });

    it('protects common abbreviation periods from sentence splitting', () => {
        const text = 'Mr. Smith met Mrs. Jones and Dr. Patel, e.g. after lunch.';

        expect(prepareTextForSentenceSplit(text))
            .toBe('Mr, Smith met Mrs, Jones and Dr, Patel, e,g, after lunch.');
    });
});

describe('normalizeSpeechText', () => {
    it('reads asterism section separators as a section boundary', () => {
        const text = '* * * I have seen the Black Sea from all sides,';

        expect(normalizeSpeechText(text))
            .toBe('Next section. I have seen the Black Sea from all sides,');
    });

    it('reads dashed section separators as a section boundary', () => {
        const text = '--- I have seen the Black Sea from all sides,';

        expect(normalizeSpeechText(text))
            .toBe('Next section. I have seen the Black Sea from all sides,');
    });

    it('adds a readable pause to numeric date ranges', () => {
        const text = '* 1/5/1735 | 22/5/1819 The admiral';

        expect(normalizeSpeechText(text))
            .toBe('May 1, 1735 to May 22, 1819. The admiral');
    });

    it('expands common abbreviations for smoother speech', () => {
        const text = 'Mr, Smith met Mrs, Jones, Ms, Ray, and Dr, Patel, e,g, after lunch.';

        expect(normalizeSpeechText(text))
            .toBe('mister Smith met misiz Jones, miz Ray, and doctor Patel, for example after lunch.');
    });
});

describe('isLocalTtsHost', () => {
    it('detects private and local hosts', () => {
        const lanHost = ['192', '168', '1', '20'].join('.');
        const privateHost = ['10', '0', '0', '15'].join('.');
        const private172Host = ['172', '20', '0', '2'].join('.');

        expect(isLocalTtsHost('localhost')).toBe(true);
        expect(isLocalTtsHost(lanHost)).toBe(true);
        expect(isLocalTtsHost(privateHost)).toBe(true);
        expect(isLocalTtsHost(private172Host)).toBe(true);
        expect(isLocalTtsHost('jellyfin.local')).toBe(true);
    });

    it('does not treat public hosts as local', () => {
        const publicResolverHost = ['8', '8', '8', '8'].join('.');

        expect(isLocalTtsHost('thewolfgate.com')).toBe(false);
        expect(isLocalTtsHost('jfws.thewolfgate.com')).toBe(false);
        expect(isLocalTtsHost(publicResolverHost)).toBe(false);
    });
});

describe('getTtsWsUrl', () => {
    it('uses the Jellyfin host directly on local networks', () => {
        const lanHost = ['192', '168', '1', '20'].join('.');

        expect(getTtsWsUrl({ hostname: lanHost }, 'test-token', 'test-user'))
            .toBe(`ws://${lanHost}:7878/?token=test-token&userId=test-user`);
    });

    it('formats local IPv6 hosts as websocket URLs', () => {
        expect(getTtsWsUrl({ hostname: '::1' }, 'test-token', 'test-user'))
            .toBe('ws://[::1]:7878/?token=test-token&userId=test-user');
    });

    it('uses the public secure websocket for remote hosts', () => {
        expect(getTtsWsUrl({ hostname: 'jellyfin.thewolfgate.com' }, 'test-token', 'test-user'))
            .toBe('wss://jfws.thewolfgate.com/?token=test-token&userId=test-user');
    });
});
