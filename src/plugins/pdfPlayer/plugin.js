import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';

import { PluginType } from 'constants/pluginType';

import loading from '../../components/loading/loading';
import keyboardnavigation from '../../scripts/keyboardNavigation';
import dialogHelper from '../../components/dialogHelper/dialogHelper';
import dom from '../../utils/dom';
import { appRouter } from '../../components/router/appRouter';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from '../../utils/events.ts';
import * as userSettings from '../../scripts/settings/userSettings';

import './style.scss';
import '../../elements/emby-button/paper-icon-button-light';

export class PdfPlayer {
    constructor() {
        this.name = 'PDF Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'pdfplayer';
        this.priority = 1;

        this.onDialogClosed = this.onDialogClosed.bind(this);
        this.onWindowKeyDown = this.onWindowKeyDown.bind(this);
        this.onTouchStart = this.onTouchStart.bind(this);
        this.onColorInversionChanged = this.onColorInversionChanged.bind(this);
        this.onViewChanged = this.onViewChanged.bind(this);
    }

    play(options) {
        this.progress = 0;
        this.loaded = false;
        this.cancellationToken = false;
        this.pages = {};

        const mediaSourceId = options.items[0].Id;
        this.pdfPlayerSettings = userSettings.getPdfPlayerSettings(mediaSourceId);

        loading.show();

        const elem = this.createMediaElement();
        return this.setCurrentSrc(elem, options);
    }

    stop() {
        this.unbindEvents();

        const stopInfo = {
            src: this.item
        };

        Events.trigger(this, 'stopped', [stopInfo]);

        const mediaSourceId = this.item.Id;
        userSettings.setPdfPlayerSettings(this.pdfPlayerSettings, mediaSourceId);

        const elem = this.mediaElement;
        if (elem) {
            dialogHelper.close(elem);
            this.mediaElement = null;
        }

        // hide loading animation
        loading.hide();

        // cancel page render
        this.cancellationToken = true;
    }

    destroy() {
        // Nothing to do here
    }

    currentItem() {
        return this.item;
    }

    currentTime() {
        return this.progress;
    }

    duration() {
        return this.book ? this.book.numPages : 0;
    }

    volume() {
        return 100;
    }

    isMuted() {
        return false;
    }

    paused() {
        return false;
    }

    seekable() {
        return true;
    }

    onWindowKeyDown(e) {
        if (!this.loaded) return;

        // Skip modified keys
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

        const key = keyboardnavigation.getKeyName(e);

        switch (key) {
            case 'KeyL':
            case 'ArrowRight':
            case 'Right':
                e.preventDefault();
                this.next();
                break;
            case 'KeyJ':
            case 'ArrowLeft':
            case 'Left':
                e.preventDefault();
                this.previous();
                break;
            case 'Escape':
                e.preventDefault();
                this.stop();
                break;
        }
    }

    onTouchStart(e) {
        if (!this.loaded || !e.touches || e.touches.length === 0) return;
        if (e.touches[0].clientX < dom.getWindowSize().innerWidth / 2) {
            this.previous();
        } else {
            this.next();
        }
    }

    onDialogClosed() {
        this.stop();
    }

    onViewChanged() {
        let view = this.pdfPlayerSettings.pagesPerView;

        if (!view || view === 1) {
            view = 2;
        } else {
            view = 1;
        }

        this.pdfPlayerSettings.pagesPerView = view;
        this.changeView(view);
    }

    onColorInversionChanged() {
        this.pdfPlayerSettings.invertColors = !this.pdfPlayerSettings.invertColors;
        this.updateColorInversion();
    }

    updateColorInversion() {
        const enabled = this.pdfPlayerSettings.invertColors;

        this.mediaElement.classList.toggle('pdfPlayerInvertColors', enabled);

        const button = this.mediaElement.querySelector('.btnToggleColorInversion');
        button.title = enabled ? 'Disable Color Inversion' : 'Invert Colors';
        button.classList.toggle('active', enabled);
        button.setAttribute('aria-pressed', enabled.toString());
    }

    changeView(view) {
        const prevIcon = view === 1 ? 'devices_fold' : 'import_contacts';
        this.mediaElement.querySelector('.btnToggleView > span').classList.remove(prevIcon);

        const newIcon = view === 1 ? 'import_contacts' : 'devices_fold';
        this.mediaElement.querySelector('.btnToggleView > span').classList.add(newIcon);

        const viewTitle = view === 1 ? 'Double Page View' : 'Single Page View';
        this.mediaElement.querySelector('.btnToggleView').title = viewTitle;

        this.pages = {};
        this.loadPage(this.progress + 1);
    }

    bindMediaElementEvents() {
        const elem = this.mediaElement;

        elem.addEventListener('close', this.onDialogClosed, { once: true });
        elem.querySelector('.btnExit').addEventListener('click', this.onDialogClosed, { once: true });
        elem.querySelector('.btnToggleColorInversion').addEventListener('click', this.onColorInversionChanged);
        elem.querySelector('.btnToggleView').addEventListener('click', this.onViewChanged);
    }

    bindEvents() {
        this.bindMediaElementEvents();

        document.addEventListener('keydown', this.onWindowKeyDown);
        document.addEventListener('touchstart', this.onTouchStart);
    }

    unbindMediaElementEvents() {
        const elem = this.mediaElement;

        elem.removeEventListener('close', this.onDialogClosed);
        elem.querySelector('.btnExit').removeEventListener('click', this.onDialogClosed);
        elem.querySelector('.btnToggleColorInversion').removeEventListener('click', this.onColorInversionChanged);
        elem.querySelector('.btnToggleView').removeEventListener('click', this.onViewChanged);
    }

    unbindEvents() {
        if (this.mediaElement) {
            this.unbindMediaElementEvents();
        }

        document.removeEventListener('keydown', this.onWindowKeyDown);
        document.removeEventListener('touchstart', this.onTouchStart);
    }

    createMediaElement() {
        let elem = this.mediaElement;
        if (elem) {
            return elem;
        }

        elem = document.getElementById('pdfPlayer');
        if (!elem) {
            elem = dialogHelper.createDialog({
                exitAnimationDuration: 400,
                size: 'fullscreen',
                autoFocus: false,
                scrollY: false,
                exitAnimation: 'fadeout',
                removeOnClose: true
            });

            const viewIcon = this.pdfPlayerSettings.pagesPerView === 1 ? 'import_contacts' : 'devices_fold';

            let html = '';
            html += '<div class="pdfPageContainer"></div>';
            html += '<div class="actionButtons">';
            html += '<button is="paper-icon-button-light" class="autoSize btnToggleColorInversion" tabindex="-1"><span class="material-icons actionButtonIcon invert_colors" aria-hidden="true"></span></button>';
            html += `<button is="paper-icon-button-light" class="autoSize btnToggleView" tabindex="-1"><span class="material-icons actionButtonIcon ${viewIcon}" aria-hidden="true"></span></button>`;
            html += '<button is="paper-icon-button-light" class="autoSize btnExit" tabindex="-1"><span class="material-icons actionButtonIcon close" aria-hidden="true"></span></button>';
            html += '</div>';

            elem.id = 'pdfPlayer';
            elem.innerHTML = html;

            dialogHelper.open(elem);
        }

        this.mediaElement = elem;

        const viewTitle = this.pdfPlayerSettings.pagesPerView === 1 ? 'Double Page View' : 'Single Page View';
        this.mediaElement.querySelector('.btnToggleView').title = viewTitle;
        this.updateColorInversion();

        return elem;
    }

    setCurrentSrc(elem, options) {
        const item = options.items[0];

        this.item = item;
        this.streamInfo = {
            started: true,
            ended: false,
            item: this.item,
            mediaSource: {
                Id: item.Id
            }
        };

        return import('pdfjs-dist').then(({ GlobalWorkerOptions, getDocument }) => {
            const api = ServerConnections.getApi(item.ServerId);
            if (!api) {
                console.error('[PdfPlayer] no Api instance available for server', item.ServerId);
                return;
            }

            const downloadHref = getLibraryApi(api).getDownloadUrl({ itemId: item.Id });

            this.bindEvents();
            GlobalWorkerOptions.workerSrc = appRouter.baseUrl() + '/libraries/pdf.worker.js';

            const downloadTask = getDocument({
                url: downloadHref,
                // Disable for PDF.js XSS vulnerability
                // https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq
                isEvalSupported: false
            });
            return downloadTask.promise.then(book => {
                if (this.cancellationToken) return;
                this.book = book;
                this.loaded = true;

                const percentageTicks = options.startPositionTicks / 10000;
                if (percentageTicks !== 0) {
                    this.loadPage(percentageTicks + 1);
                    this.progress = percentageTicks;
                } else {
                    this.loadPage(1);
                }
            });
        });
    }

    next() {
        if (this.progress >= this.duration() - 1) return;

        const nextProgress = Math.min(this.progress + this.pdfPlayerSettings.pagesPerView, this.duration() - 1);
        this.loadPage(nextProgress + 1);
        this.progress = nextProgress;

        Events.trigger(this, 'pause');
    }

    previous() {
        if (this.progress === 0) return;

        const previousProgress = Math.max(this.progress - this.pdfPlayerSettings.pagesPerView, 0);
        this.loadPage(previousProgress + 1);
        this.progress = previousProgress;

        Events.trigger(this, 'pause');
    }

    replacePages(pageNumbers) {
        const container = this.mediaElement.querySelector('.pdfPageContainer');
        container.innerHTML = '';

        for (const pageNumber of pageNumbers) {
            container.appendChild(this.pages[`page${pageNumber}`]);
        }
    }

    loadPage(number) {
        const prefix = 'page';
        const pad = 2;
        const visiblePages = this.getVisiblePageNumbers(number);

        // generate list of cached pages by padding the requested page on both sides
        const pages = visiblePages.map(pageNumber => prefix + pageNumber);
        for (let i = 1; i <= pad; i++) {
            if (number - i > 0) pages.push(prefix + (number - i));
            if (number + this.pdfPlayerSettings.pagesPerView - 1 + i <= this.duration()) {
                pages.push(prefix + (number + this.pdfPlayerSettings.pagesPerView - 1 + i));
            }
        }

        // load any missing pages in the cache
        for (const page of pages) {
            if (!this.pages[page]) {
                this.pages[page] = document.createElement('canvas');
                this.renderPage(this.pages[page], parseInt(page.slice(4), 10));
            }
        }

        // show the requested page or pages
        this.replacePages(visiblePages);

        // delete all pages outside the cache area
        for (const page in this.pages) {
            if (!pages.includes(page)) {
                delete this.pages[page];
            }
        }
    }

    getVisiblePageNumbers(number) {
        const pages = [];
        const pagesPerView = this.pdfPlayerSettings.pagesPerView;

        for (let i = 0; i < pagesPerView; i++) {
            const pageNumber = number + i;
            if (pageNumber <= this.duration()) {
                pages.push(pageNumber);
            }
        }

        return pages;
    }

    renderPage(canvas, number) {
        const devicePixelRatio = window.devicePixelRatio || 1;
        this.book.getPage(number).then(page => {
            const original = page.getViewport({ scale: 1 });
            const pageWidth = window.innerWidth / this.pdfPlayerSettings.pagesPerView;
            const scale = Math.min((window.innerHeight / original.height), (pageWidth / original.width)) * devicePixelRatio;
            const viewport = page.getViewport({ scale });

            canvas.width = viewport.width;
            canvas.height = viewport.height;

            canvas.style.maxWidth = `${100 / this.pdfPlayerSettings.pagesPerView}%`;
            canvas.style.maxHeight = '100%';

            const context = canvas.getContext('2d');

            const renderContext = {
                canvasContext: context,
                viewport: viewport
            };

            const renderTask = page.render(renderContext);
            renderTask.promise.then(() => {
                loading.hide();
            });
        });
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'book';
    }

    canPlayItem(item) {
        return item.Path ? item.Path.toLowerCase().endsWith('pdf') : false;
    }
}

export default PdfPlayer;
