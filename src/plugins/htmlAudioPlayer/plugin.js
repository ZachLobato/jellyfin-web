import { AppFeature } from 'constants/appFeature';
import { PluginType } from 'constants/pluginType';
import { MediaError } from 'types/mediaError';

import browser from '../../scripts/browser';
import { appHost } from '../../components/apphost';
import * as htmlMediaHelper from '../../components/htmlMediaHelper';
import profileBuilder from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import Events from '../../utils/events.ts';

// Give the next decoder enough time to start, then use Web Audio gain ramps to
// blend its first second with the final second of the outgoing track.
const GAPLESS_CROSSFADE_MS = 1000;
const GAPLESS_SCHEDULE_WINDOW_MS = 2000;

function getDefaultProfile() {
    return profileBuilder({});
}

let fadeTimeout;
function fade(instance, elem, startingVolume) {
    instance._isFadingOut = true;

    // Need to record the starting volume on each pass rather than querying elem.volume
    // This is due to iOS safari not allowing volume changes and always returning the system volume value
    const newVolume = Math.max(0, startingVolume - 0.15);
    console.debug('fading volume to ' + newVolume);
    elem.volume = newVolume;

    if (newVolume <= 0) {
        instance._isFadingOut = false;
        return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
        cancelFadeTimeout();
        fadeTimeout = setTimeout(function () {
            fade(instance, elem, newVolume).then(resolve, reject);
        }, 100);
    });
}

function cancelFadeTimeout() {
    const timeout = fadeTimeout;
    if (timeout) {
        clearTimeout(timeout);
        fadeTimeout = null;
    }
}

function supportsFade() {
    // Not working on tizen.
    // We could possibly enable on other tv's, but all smart tv browsers tend to be pretty primitive
    return !browser.tv;
}

function requireHlsPlayer(callback) {
    import('hls.js/dist/hls.js').then(({ default: hls }) => {
        hls.DefaultConfig.lowLatencyMode = false;
        hls.DefaultConfig.backBufferLength = Infinity;
        hls.DefaultConfig.liveBackBufferLength = 90;
        window.Hls = hls;
        callback();
    });
}

function enableHlsPlayer(url, item, mediaSource, mediaType) {
    if (!htmlMediaHelper.enableHlsJsPlayer(mediaSource.RunTimeTicks, mediaType)) {
        return Promise.reject();
    }

    if (url.indexOf('.m3u8') !== -1) {
        return Promise.resolve();
    }

    // issue head request to get content type
    return new Promise(function (resolve, reject) {
        import('../../utils/fetch').then((fetchHelper) => {
            fetchHelper.ajax({
                url: url,
                type: 'HEAD'
            }).then(function (response) {
                const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
                if (contentType === 'application/vnd.apple.mpegurl' || contentType === 'application/x-mpegurl') {
                    resolve();
                } else {
                    reject();
                }
            }, reject);
        });
    });
}

class HtmlAudioPlayer {
    constructor() {
        const self = this;

        self.name = 'Html Audio Player';
        self.type = PluginType.MediaPlayer;
        self.id = 'htmlaudioplayer';

        // Let any players created by plugins take priority
        self.priority = 1;
        self._gainNodes = new WeakMap();
        self._sourceNodes = new WeakMap();
        self._normalizationGains = new WeakMap();

        self.play = function (options) {
            self._started = false;
            self._timeUpdated = false;
            self._currentTime = null;

            if (isMatchingPreload(options)) {
                return playPreloaded(options);
            }

            self.clearPreload();
            const elem = createMediaElement();

            return setCurrentSrc(elem, options);
        };

        function isMatchingPreload(options) {
            const preloadedItem = self._preloadedOptions?.item;
            return self._preloadedElement
                && (preloadedItem?.PlaylistItemId || preloadedItem?.Id)
                    === (options.item?.PlaylistItemId || options.item?.Id);
        }

        self.getPreloadedOptions = function (item) {
            return isMatchingPreload({ item }) ? self._preloadedOptions : null;
        };

        function playPreloaded(options) {
            const previousElement = self._mediaElement;
            const elem = self._preloadedElement;
            const alreadyPlaying = self._preloadedStarted;

            self._preloadedElement = null;
            self._preloadedOptions = null;
            self._preloadedStarted = false;
            self._isPreloadStillNext = null;

            if (previousElement && previousElement !== elem) {
                unBindEvents(previousElement);
                disconnectAudioNodes(previousElement);
                htmlMediaHelper.resetSrc(previousElement);
                previousElement.remove();
            }

            self._mediaElement = elem;
            elem.classList.remove('mediaPlayerAudioPreload');
            elem.classList.add('mediaPlayerAudio');
            elem.autoplay = true;
            bindEvents(elem);

            self._currentPlayOptions = options;
            self._currentSrc = options.url;
            applyNormalization(elem, options);
            console.debug('[gapless] promoting preloaded audio track');

            return resumeAudioContext().then(() => htmlMediaHelper.playWithPromise(elem, onError)).then(() => {
                // The standby element may have been started by the previous element's
                // ended handler before PlaybackManager finished advancing its state.
                if (alreadyPlaying && !elem.paused && !self._started) {
                    onPlaying.call(elem, { target: elem });
                }
            });
        }

        self.preload = async function (options, isStillNext) {
            // Progressive audio transcodes can be buffered just like direct-play
            // files. HLS has a separate segmented lifecycle and remains on the
            // established single-element path.
            if (options.mediaSource?.TranscodingSubProtocol === 'hls'
                || options.url?.includes('.m3u8')) {
                console.debug('[gapless] preload unavailable for HLS audio');
                self.clearPreload();
                return;
            }

            self.clearPreload();

            const elem = document.createElement('audio');
            elem.classList.add('mediaPlayerAudioPreload', 'hide');
            elem.preload = 'auto';
            elem.volume = self._mediaElement?.volume ?? htmlMediaHelper.getSavedVolume();
            elem.muted = self._mediaElement?.muted ?? false;

            const crossOrigin = htmlMediaHelper.getCrossOriginValue(options.mediaSource);
            if (crossOrigin) {
                elem.crossOrigin = crossOrigin;
            }

            self._preloadedElement = elem;
            self._preloadedOptions = options;
            self._isPreloadStillNext = isStillNext;
            document.body.appendChild(elem);

            if (await getIncludeCorsCredentials()) {
                elem.crossOrigin = 'use-credentials';
            }

            if (self._preloadedElement !== elem) return;

            await htmlMediaHelper.applySrc(elem, options.url, options);
            await applyNormalization(elem, options, false);
            elem.load();
            console.debug('[gapless] next audio track is preloading');
            scheduleGaplessTransition(self._mediaElement);
        };

        self.clearPreload = function () {
            clearGaplessTransition();
            const elem = self._preloadedElement;
            self._preloadedElement = null;
            self._preloadedOptions = null;
            self._preloadedStarted = false;
            self._isPreloadStillNext = null;

            if (elem) {
                disconnectAudioNodes(elem);
                htmlMediaHelper.resetSrc(elem);
                elem.remove();
            }
        };

        function applyNormalization(elem, options, activate = true) {
            return import('../../scripts/settings/userSettings').then((userSettings) => {
                let normalizationGain = 0;
                if (userSettings.selectAudioNormalization() == 'TrackGain') {
                    normalizationGain = options.item.NormalizationGain
                        ?? options.mediaSource.albumNormalizationGain;
                } else if (userSettings.selectAudioNormalization() == 'AlbumGain') {
                    normalizationGain = options.mediaSource.albumNormalizationGain
                        ?? options.item.NormalizationGain;
                } else {
                    console.debug('normalization disabled');
                }

                let gainNode = self._gainNodes.get(elem);
                if (!gainNode) {
                    gainNode = addGainElement(elem);
                    if (!gainNode) return;
                }
                if (activate) {
                    self.gainNode = gainNode;
                }

                let gain = normalizationGain ? Math.pow(10, normalizationGain / 20) : 1;
                if (browser.safari) {
                    gain *= elem.volume;
                }
                self._normalizationGains.set(elem, gain);
                gainNode.gain.value = activate ? gain : 0;
                if (activate) self.normalizationGain = gain;
                console.debug('gain: ' + gainNode.gain.value);
            }).catch((err) => {
                console.error('Failed to add/change gainNode', err);
            });
        }

        function setCurrentSrc(elem, options) {
            unBindEvents(elem);
            bindEvents(elem);

            let val = options.url;
            console.debug('playing url: ' + val);
            applyNormalization(elem, options);

            // Convert to seconds
            const seconds = (options.playerStartPositionTicks || 0) / 10000000;
            if (seconds) {
                val += '#t=' + seconds;
            }

            htmlMediaHelper.destroyHlsPlayer(self);

            self._currentPlayOptions = options;

            const crossOrigin = htmlMediaHelper.getCrossOriginValue(options.mediaSource);
            if (crossOrigin) {
                elem.crossOrigin = crossOrigin;
            }

            return enableHlsPlayer(val, options.item, options.mediaSource, 'Audio').then(function () {
                return new Promise(function (resolve, reject) {
                    requireHlsPlayer(async () => {
                        const includeCorsCredentials = await getIncludeCorsCredentials();

                        const hls = new Hls({
                            manifestLoadingTimeOut: 20000,
                            xhrSetup: function (xhr) {
                                xhr.withCredentials = includeCorsCredentials;
                            }
                        });
                        hls.loadSource(val);
                        hls.attachMedia(elem);

                        htmlMediaHelper.bindEventsToHlsPlayer(self, hls, elem, onError, resolve, reject);

                        self._hlsPlayer = hls;

                        self._currentSrc = val;
                    });
                });
            }, async () => {
                elem.autoplay = true;

                const includeCorsCredentials = await getIncludeCorsCredentials();
                if (includeCorsCredentials) {
                    // Safari will not send cookies without this
                    elem.crossOrigin = 'use-credentials';
                }

                return htmlMediaHelper.applySrc(elem, val, options).then(function () {
                    self._currentSrc = val;

                    return htmlMediaHelper.playWithPromise(elem, onError);
                });
            });
        }

        function bindEvents(elem) {
            elem.addEventListener('timeupdate', onTimeUpdate);
            elem.addEventListener('ended', onEnded);
            elem.addEventListener('volumechange', onVolumeChange);
            elem.addEventListener('pause', onPause);
            elem.addEventListener('playing', onPlaying);
            elem.addEventListener('play', onPlay);
            elem.addEventListener('waiting', onWaiting);
        }

        function unBindEvents(elem) {
            elem.removeEventListener('timeupdate', onTimeUpdate);
            elem.removeEventListener('ended', onEnded);
            elem.removeEventListener('volumechange', onVolumeChange);
            elem.removeEventListener('pause', onPause);
            elem.removeEventListener('playing', onPlaying);
            elem.removeEventListener('play', onPlay);
            elem.removeEventListener('waiting', onWaiting);
            elem.removeEventListener('error', onError); // bound in htmlMediaHelper
        }

        self.stop = function (destroyPlayer) {
            cancelFadeTimeout();
            clearGaplessTransition();

            const elem = self._mediaElement;
            const src = self._currentSrc;

            if (elem && src) {
                if (!destroyPlayer || !supportsFade()) {
                    elem.pause();

                    htmlMediaHelper.onEndedInternal(self, elem, onError);

                    if (destroyPlayer) {
                        self.destroy();
                    }
                    return Promise.resolve();
                }

                const originalVolume = elem.volume;

                return fade(self, elem, elem.volume).then(function () {
                    elem.pause();
                    elem.volume = originalVolume;

                    htmlMediaHelper.onEndedInternal(self, elem, onError);

                    if (destroyPlayer) {
                        self.destroy();
                    }
                });
            }
            return Promise.resolve();
        };

        self.destroy = function () {
            self.clearPreload();
            unBindEvents(self._mediaElement);
            disconnectAudioNodes(self._mediaElement);
            htmlMediaHelper.resetSrc(self._mediaElement);
        };

        function createMediaElement() {
            let elem = self._mediaElement;

            if (elem) {
                return elem;
            }

            elem = document.querySelector('.mediaPlayerAudio');

            if (!elem) {
                elem = document.createElement('audio');
                elem.classList.add('mediaPlayerAudio');
                elem.classList.add('hide');

                document.body.appendChild(elem);
            }

            // TODO: Move volume control to PlaybackManager. Player should just be a wrapper that translates commands into API calls.
            if (!appHost.supports(AppFeature.PhysicalVolumeControl)) {
                elem.volume = htmlMediaHelper.getSavedVolume();
            }

            self._mediaElement = elem;

            return elem;
        }

        function addGainElement(elem) {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext; /* eslint-disable-line compat/compat */

                const audioCtx = self._audioContext || new AudioContext();
                self._audioContext = audioCtx;
                const source = audioCtx.createMediaElementSource(elem);

                const gainNode = audioCtx.createGain();

                source.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                self._sourceNodes.set(elem, source);
                self._gainNodes.set(elem, gainNode);
                return gainNode;
            } catch (e) {
                console.error('Web Audio API is not supported in this browser', e);
            }
        }

        function disconnectAudioNodes(elem) {
            self._sourceNodes.get(elem)?.disconnect();
            self._gainNodes.get(elem)?.disconnect();
            self._sourceNodes.delete(elem);
            self._gainNodes.delete(elem);
            self._normalizationGains.delete(elem);
        }

        function resumeAudioContext() {
            const audioContext = self._audioContext;
            if (audioContext?.state === 'suspended') {
                return audioContext.resume().catch((err) => {
                    console.debug('[gapless] unable to resume audio context', err);
                });
            }
            return Promise.resolve();
        }

        function crossfadeToPreloadedElement(preloadedElement) {
            const audioContext = self._audioContext;
            const currentGain = self._gainNodes.get(self._mediaElement);
            const nextGain = self._gainNodes.get(preloadedElement);
            if (!audioContext || !currentGain || !nextGain) return;

            const startTime = audioContext.currentTime;
            const endTime = startTime + GAPLESS_CROSSFADE_MS / 1000;
            const nextTarget = self._normalizationGains.get(preloadedElement) ?? 1;

            currentGain.gain.cancelScheduledValues(startTime);
            currentGain.gain.setValueAtTime(currentGain.gain.value, startTime);
            currentGain.gain.linearRampToValueAtTime(0, endTime);

            nextGain.gain.cancelScheduledValues(startTime);
            nextGain.gain.setValueAtTime(0, startTime);
            nextGain.gain.linearRampToValueAtTime(nextTarget, endTime);
        }

        function resetCrossfade() {
            const audioContext = self._audioContext;
            if (!audioContext) return;

            const currentGain = self._gainNodes.get(self._mediaElement);
            const nextGain = self._gainNodes.get(self._preloadedElement);
            const currentTarget = self._normalizationGains.get(self._mediaElement) ?? 1;

            if (currentGain) {
                currentGain.gain.cancelScheduledValues(audioContext.currentTime);
                currentGain.gain.value = currentTarget;
            }
            if (nextGain) {
                nextGain.gain.cancelScheduledValues(audioContext.currentTime);
                nextGain.gain.value = 0;
            }
        }

        function clearGaplessTransition() {
            if (self._gaplessTransitionTimeout) {
                clearTimeout(self._gaplessTransitionTimeout);
                self._gaplessTransitionTimeout = null;
            }
        }

        function startPreloadedElement() {
            const preloadedElement = self._preloadedElement;
            if (self._preloadedStarted
                || !self._isPreloadStillNext?.()
                || !preloadedElement
                || preloadedElement.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
                return;
            }

            self._preloadedStarted = true;
            console.debug('[gapless] starting one-second audio crossfade');
            resumeAudioContext().then(() => {
                crossfadeToPreloadedElement(preloadedElement);
                return preloadedElement.play();
            }).catch((err) => {
                self._preloadedStarted = false;
                const currentGain = self._gainNodes.get(self._mediaElement);
                const currentTarget = self._normalizationGains.get(self._mediaElement) ?? 1;
                if (currentGain && self._audioContext) {
                    currentGain.gain.cancelScheduledValues(self._audioContext.currentTime);
                    currentGain.gain.value = currentTarget;
                }
                console.debug('Unable to start preloaded audio track', err);
            });
        }

        function scheduleGaplessTransition(elem) {
            clearGaplessTransition();

            if (!elem || elem !== self._mediaElement || elem.paused
                || self._preloadedStarted || !self._isPreloadStillNext?.()
                || !self._preloadedElement
                || self._preloadedElement.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
                || !htmlMediaHelper.isValidDuration(elem.duration)) {
                return;
            }

            const remainingMs = Math.max(0, (elem.duration - elem.currentTime) * 1000 / elem.playbackRate);
            const delayMs = remainingMs - GAPLESS_CROSSFADE_MS;
            if (delayMs > GAPLESS_SCHEDULE_WINDOW_MS) return;

            if (delayMs <= 0) {
                startPreloadedElement();
            } else {
                self._gaplessTransitionTimeout = setTimeout(() => {
                    self._gaplessTransitionTimeout = null;
                    if (elem === self._mediaElement && !elem.paused) {
                        startPreloadedElement();
                    }
                }, delayMs);
            }
        }

        function onEnded() {
            clearGaplessTransition();
            startPreloadedElement();
            htmlMediaHelper.onEndedInternal(self, this, onError);
        }

        function onTimeUpdate() {
            // Get the player position + the transcoding offset
            const time = this.currentTime;

            // Don't trigger events after user stop
            if (!self._isFadingOut) {
                self._currentTime = time;
                scheduleGaplessTransition(this);
                Events.trigger(self, 'timeupdate');
            }
        }

        function onVolumeChange() {
            if (!self._isFadingOut) {
                htmlMediaHelper.saveVolume(this.volume);
                if (browser.safari && self.gainNode) {
                    self.gainNode.gain.value = this.volume * self.normalizationGain;
                }
                Events.trigger(self, 'volumechange');
            }
        }

        function onPlaying(e) {
            if (!self._started) {
                self._started = true;
                this.removeAttribute('controls');

                htmlMediaHelper.seekOnPlaybackStart(self, e.target, self._currentPlayOptions.playerStartPositionTicks);
            }
            scheduleGaplessTransition(this);
            Events.trigger(self, 'playing');
        }

        function onPlay() {
            Events.trigger(self, 'unpause');
        }

        function onPause() {
            clearGaplessTransition();
            if (!this.ended && self._preloadedStarted && self._preloadedElement) {
                self._preloadedElement.pause();
                self._preloadedElement.currentTime = 0;
                self._preloadedStarted = false;
                resetCrossfade();
            }
            Events.trigger(self, 'pause');
        }

        function onWaiting() {
            Events.trigger(self, 'waiting');
        }

        function onError() {
            const errorCode = this.error ? (this.error.code || 0) : 0;
            const errorMessage = this.error ? (this.error.message || '') : '';
            console.error('media element error: ' + errorCode.toString() + ' ' + errorMessage);

            let type;

            switch (errorCode) {
                case 1:
                    // MEDIA_ERR_ABORTED
                    // This will trigger when changing media while something is playing
                    return;
                case 2:
                    // MEDIA_ERR_NETWORK
                    type = MediaError.NETWORK_ERROR;
                    break;
                case 3:
                    // MEDIA_ERR_DECODE
                    if (self._hlsPlayer) {
                        htmlMediaHelper.handleHlsJsMediaError(self);
                        return;
                    } else {
                        type = MediaError.MEDIA_DECODE_ERROR;
                    }
                    break;
                case 4:
                    // MEDIA_ERR_SRC_NOT_SUPPORTED
                    type = MediaError.MEDIA_NOT_SUPPORTED;
                    break;
                default:
                    // seeing cases where Edge is firing error events with no error code
                    // example is start playing something, then immediately change src to something else
                    return;
            }

            htmlMediaHelper.onErrorInternal(self, type);
        }
    }

    currentSrc() {
        return this._currentSrc;
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'audio';
    }

    getDeviceProfile(item) {
        if (appHost.getDeviceProfile) {
            return appHost.getDeviceProfile(item);
        }

        return getDefaultProfile();
    }

    toggleAirPlay() {
        return this.setAirPlayEnabled(!this.isAirPlayEnabled());
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            if (val != null) {
                mediaElement.currentTime = val / 1000;
                return;
            }

            const currentTime = this._currentTime;
            if (currentTime) {
                return currentTime * 1000;
            }

            return (mediaElement.currentTime || 0) * 1000;
        }
    }

    duration() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            const duration = mediaElement.duration;
            if (htmlMediaHelper.isValidDuration(duration)) {
                return duration * 1000;
            }
        }

        return null;
    }

    seekable() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            const seekable = mediaElement.seekable;
            if (seekable?.length) {
                let start = seekable.start(0);
                let end = seekable.end(0);

                if (!htmlMediaHelper.isValidDuration(start)) {
                    start = 0;
                }
                if (!htmlMediaHelper.isValidDuration(end)) {
                    end = 0;
                }

                return (end - start) > 0;
            }

            return false;
        }
    }

    getBufferedRanges() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return htmlMediaHelper.getBufferedRanges(this, mediaElement);
        }

        return [];
    }

    pause() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.pause();
        }
    }

    // This is a retry after error
    resume() {
        this.unpause();
    }

    unpause() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }

    paused() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.paused;
        }

        return false;
    }

    setPlaybackRate(value) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.playbackRate = value;
        }
    }

    getPlaybackRate() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.playbackRate;
        }
        return null;
    }

    setVolume(val) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.volume = Math.pow(val / 100, 3);
        }
    }

    getVolume() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return Math.min(Math.round(Math.pow(mediaElement.volume, 1 / 3) * 100), 100);
        }
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.muted = mute;
        }
    }

    isMuted() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.muted;
        }
        return false;
    }

    isAirPlayEnabled() {
        if (document.AirPlayEnabled) {
            return !!document.AirplayElement;
        }
        return false;
    }

    setAirPlayEnabled(isEnabled) {
        const mediaElement = this._mediaElement;

        if (mediaElement) {
            if (document.AirPlayEnabled) {
                if (isEnabled) {
                    mediaElement.requestAirPlay().catch(function(err) {
                        console.error('Error requesting AirPlay', err);
                    });
                } else {
                    document.exitAirPLay().catch(function(err) {
                        console.error('Error exiting AirPlay', err);
                    });
                }
            } else {
                mediaElement.webkitShowPlaybackTargetPicker();
            }
        }
    }

    supports(feature) {
        if (!supportedFeatures) {
            supportedFeatures = getSupportedFeatures();
        }

        return supportedFeatures.indexOf(feature) !== -1;
    }
}

let supportedFeatures;

function getSupportedFeatures() {
    const list = [];
    const audio = document.createElement('audio');

    if (typeof audio.playbackRate === 'number') {
        list.push('PlaybackRate');
    }

    if (browser.safari) {
        list.push('AirPlay');
    }

    return list;
}

export default HtmlAudioPlayer;
