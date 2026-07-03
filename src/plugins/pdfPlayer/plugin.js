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

const MAX_ZOOM_SCALE = 4;
const MIN_SWIPE_DISTANCE = 50;
const MAX_SWIPE_CROSS_AXIS_DISTANCE = 30;
const MAX_TAP_DISTANCE = 10;
const EDGE_TAP_RATIO = 0.25;
const WHEEL_ZOOM_FACTOR = 0.002;

export class PdfPlayer {
    constructor() {
        this.name = 'PDF Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'pdfplayer';
        this.priority = 1;

        this.onDialogClosed = this.onDialogClosed.bind(this);
        this.onWindowKeyDown = this.onWindowKeyDown.bind(this);
        this.onTouchStart = this.onTouchStart.bind(this);
        this.onTouchMove = this.onTouchMove.bind(this);
        this.onTouchEnd = this.onTouchEnd.bind(this);
        this.onTouchCancel = this.onTouchCancel.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onWindowKeyUp = this.onWindowKeyUp.bind(this);
        this.onNextButtonClick = this.onNextButtonClick.bind(this);
        this.onPreviousButtonClick = this.onPreviousButtonClick.bind(this);
        this.onColorInversionChanged = this.onColorInversionChanged.bind(this);
        this.onPageAdvanceChanged = this.onPageAdvanceChanged.bind(this);
        this.onViewChanged = this.onViewChanged.bind(this);
    }

    play(options) {
        this.progress = 0;
        this.loaded = false;
        this.cancellationToken = false;
        this.pages = {};
        this.resetZoomState();

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

        if (keyboardnavigation.getKeyName(e) === 'Space') {
            this.isSpacePressed = true;
            this.applyZoomTransform();
            e.preventDefault();
            return;
        }

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

    onWindowKeyUp(e) {
        if (keyboardnavigation.getKeyName(e) !== 'Space') return;

        this.isSpacePressed = false;
        this.applyZoomTransform();
    }

    onWheel(e) {
        if (!this.loaded || e.target.closest('.actionButtons')) return;

        if (e.metaKey) {
            e.preventDefault();
            this.zoomAtPoint(e.clientX, e.clientY, this.renderedZoomScale * (1 - e.deltaY * WHEEL_ZOOM_FACTOR));
            return;
        }

        if (e.shiftKey) {
            e.preventDefault();
            this.panBy(e.deltaX || e.deltaY, 0);
            return;
        }

        if (this.renderedZoomScale > 1 && e.deltaX !== 0) {
            e.preventDefault();
            this.panBy(e.deltaX, e.deltaY);
        }
    }

    onMouseDown(e) {
        if (!this.loaded || !this.isSpacePressed || e.button !== 0 || e.target.closest('.actionButtons')) return;

        e.preventDefault();
        const container = this.mediaElement.querySelector('.pdfPageContainer');
        this.mousePanGesture = {
            startX: e.clientX,
            startY: e.clientY,
            startScrollLeft: container.scrollLeft,
            startScrollTop: container.scrollTop,
            startTranslateX: this.zoomTranslateX,
            startTranslateY: this.zoomTranslateY
        };
        this.applyZoomTransform();
    }

    onMouseMove(e) {
        if (!this.mousePanGesture) return;

        if (e.buttons === 0) {
            this.mousePanGesture = null;
            this.applyZoomTransform();
            return;
        }

        e.preventDefault();
        const container = this.mediaElement.querySelector('.pdfPageContainer');
        const contentSize = this.getRenderedContentSize();
        const deltaX = e.clientX - this.mousePanGesture.startX;
        const deltaY = e.clientY - this.mousePanGesture.startY;

        if (contentSize.width > container.clientWidth) {
            container.scrollLeft = this.mousePanGesture.startScrollLeft - deltaX;
            this.zoomTranslateX = 0;
        } else {
            this.zoomTranslateX = this.mousePanGesture.startTranslateX + deltaX;
        }

        if (contentSize.height > container.clientHeight) {
            container.scrollTop = this.mousePanGesture.startScrollTop - deltaY;
            this.zoomTranslateY = 0;
        } else {
            this.zoomTranslateY = this.mousePanGesture.startTranslateY + deltaY;
        }

        this.constrainRenderedTranslation();
        this.applyZoomTransform();
    }

    onMouseUp() {
        if (!this.mousePanGesture) return;

        this.mousePanGesture = null;
        this.applyZoomTransform();
    }

    onNextButtonClick(e) {
        e.preventDefault();
        this.next();
    }

    onPreviousButtonClick(e) {
        e.preventDefault();
        this.previous();
    }

    onTouchStart(e) {
        if (!this.loaded || !e.touches || e.touches.length === 0 || e.target.closest('.actionButtons')) return;

        if (e.touches.length === 2) {
            e.preventDefault();
            this.beginPinchGesture(e.touches);
            return;
        }

        const touch = e.touches[0];

        this.touchGesture = {
            type: 'tap',
            startX: touch.clientX,
            startY: touch.clientY,
            startTranslateX: this.zoomTranslateX,
            startTranslateY: this.zoomTranslateY
        };
    }

    onTouchMove(e) {
        if (!this.loaded || !this.touchGesture) return;

        if (e.touches.length === 2) {
            e.preventDefault();

            if (this.touchGesture.type !== 'pinch') {
                this.beginPinchGesture(e.touches);
            }

            this.updatePinchGesture(e.touches);
            return;
        }

        if (e.touches.length !== 1) return;

        const touch = e.touches[0];
        const deltaX = touch.clientX - this.touchGesture.startX;
        const deltaY = touch.clientY - this.touchGesture.startY;

        if (this.zoomScale > 1) {
            e.preventDefault();
            this.touchGesture.type = 'pan';
            this.zoomTranslateX = this.touchGesture.startTranslateX + deltaX;
            this.zoomTranslateY = this.touchGesture.startTranslateY + deltaY;
            this.constrainZoomTranslation();
            this.applyZoomTransform();
        }

        this.touchGesture.deltaX = deltaX;
        this.touchGesture.deltaY = deltaY;
    }

    onTouchEnd(e) {
        if (!this.loaded || !this.touchGesture) return;

        if (e.touches?.length) {
            if (e.touches.length === 1 && this.touchGesture.type === 'pinch') {
                const touch = e.touches[0];
                this.touchGesture = {
                    type: 'pan',
                    startX: touch.clientX,
                    startY: touch.clientY,
                    startTranslateX: this.zoomTranslateX,
                    startTranslateY: this.zoomTranslateY
                };
            }

            return;
        }

        if (this.touchGesture.type === 'tap') {
            this.handleTapOrSwipe(e.changedTouches?.[0]);
        }

        this.touchGesture = null;
    }

    onTouchCancel() {
        this.touchGesture = null;
    }

    beginPinchGesture(touches) {
        const midpoint = this.getTouchMidpoint(touches);

        this.touchGesture = {
            type: 'pinch',
            startDistance: this.getTouchDistance(touches),
            startScale: this.zoomScale,
            startX: midpoint.x,
            startY: midpoint.y,
            startTranslateX: this.zoomTranslateX,
            startTranslateY: this.zoomTranslateY
        };
    }

    updatePinchGesture(touches) {
        const midpoint = this.getTouchMidpoint(touches);
        const nextScale = this.touchGesture.startScale * (this.getTouchDistance(touches) / this.touchGesture.startDistance);

        this.zoomScale = Math.min(Math.max(nextScale, 1), MAX_ZOOM_SCALE);
        this.zoomTranslateX = this.touchGesture.startTranslateX + midpoint.x - this.touchGesture.startX;
        this.zoomTranslateY = this.touchGesture.startTranslateY + midpoint.y - this.touchGesture.startY;
        this.constrainZoomTranslation();
        this.applyZoomTransform();
    }

    handleTapOrSwipe(touch) {
        if (!touch) return;

        const deltaX = this.touchGesture.deltaX || 0;
        const deltaY = this.touchGesture.deltaY || 0;

        if (Math.abs(deltaX) >= MIN_SWIPE_DISTANCE && Math.abs(deltaY) < MAX_SWIPE_CROSS_AXIS_DISTANCE) {
            if (deltaX < 0) {
                this.next();
            } else {
                this.previous();
            }

            return;
        }

        if (Math.abs(deltaX) > MAX_TAP_DISTANCE || Math.abs(deltaY) > MAX_TAP_DISTANCE) return;

        const width = dom.getWindowSize().innerWidth;

        if (touch.clientX < width * EDGE_TAP_RATIO) {
            this.previous();
        } else if (touch.clientX > width * (1 - EDGE_TAP_RATIO)) {
            this.next();
        }
    }

    getTouchDistance(touches) {
        return Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY
        );
    }

    getTouchMidpoint(touches) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2
        };
    }

    constrainZoomTranslation() {
        if (this.zoomScale <= 1) {
            this.zoomTranslateX = 0;
            this.zoomTranslateY = 0;
            return;
        }

        const container = this.mediaElement?.querySelector('.pdfPageContainer');
        const maxX = ((container?.clientWidth || dom.getWindowSize().innerWidth) * (this.zoomScale - 1)) / 2;
        const maxY = ((container?.clientHeight || dom.getWindowSize().innerHeight) * (this.zoomScale - 1)) / 2;

        this.zoomTranslateX = Math.min(Math.max(this.zoomTranslateX, -maxX), maxX);
        this.zoomTranslateY = Math.min(Math.max(this.zoomTranslateY, -maxY), maxY);
    }

    zoomAtPoint(clientX, clientY, nextScale) {
        const container = this.mediaElement?.querySelector('.pdfPageContainer');
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const cursorX = clientX - rect.left;
        const cursorY = clientY - rect.top;
        const oldScale = this.renderedZoomScale || 1;
        const newScale = Math.min(Math.max(nextScale, 1), MAX_ZOOM_SCALE);

        if (newScale === oldScale) return;

        const contentX = (container.scrollLeft + cursorX) / oldScale;
        const contentY = (container.scrollTop + cursorY) / oldScale;

        this.zoomScale = newScale;
        this.zoomTranslateX = 0;
        this.zoomTranslateY = 0;

        if (newScale <= 1) {
            container.scrollLeft = 0;
            container.scrollTop = 0;
        }

        this.applyZoomTransform();
        this.renderVisiblePages().then(() => {
            if (this.zoomScale !== newScale) return;

            this.renderedZoomScale = this.zoomScale;
            this.constrainRenderedTranslation();
            this.applyZoomTransform();
            container.scrollLeft = contentX * newScale - cursorX;
            container.scrollTop = contentY * newScale - cursorY;
        });
    }

    panBy(deltaX, deltaY) {
        const container = this.mediaElement?.querySelector('.pdfPageContainer');
        if (!container || this.renderedZoomScale <= 1) return;
        const contentSize = this.getRenderedContentSize();

        if (contentSize.width > container.clientWidth) {
            container.scrollLeft += deltaX;
            this.zoomTranslateX = 0;
        } else {
            this.zoomTranslateX -= deltaX;
        }

        if (contentSize.height > container.clientHeight) {
            container.scrollTop += deltaY;
            this.zoomTranslateY = 0;
        } else {
            this.zoomTranslateY -= deltaY;
        }

        this.constrainRenderedTranslation();
        this.applyZoomTransform();
    }

    getRenderedContentSize() {
        const container = this.mediaElement?.querySelector('.pdfPageContainer');
        if (!container) {
            return {
                height: 0,
                width: 0
            };
        }

        const canvases = Array.from(container.querySelectorAll('canvas'));

        return canvases.reduce((size, canvas) => ({
            height: Math.max(size.height, canvas.offsetHeight),
            width: size.width + canvas.offsetWidth
        }), {
            height: 0,
            width: 0
        });
    }

    constrainRenderedTranslation() {
        const container = this.mediaElement?.querySelector('.pdfPageContainer');
        if (!container || this.renderedZoomScale <= 1) {
            return;
        }

        const contentSize = this.getRenderedContentSize();

        if (contentSize.width > container.clientWidth) {
            this.zoomTranslateX = 0;
        } else {
            this.zoomTranslateX = Math.min(Math.max(this.zoomTranslateX, -container.clientWidth), container.clientWidth);
        }

        if (contentSize.height > container.clientHeight) {
            this.zoomTranslateY = 0;
        } else {
            this.zoomTranslateY = Math.min(Math.max(this.zoomTranslateY, -container.clientHeight), container.clientHeight);
        }
    }

    updateRenderedZoomAlignment(container) {
        if (this.renderedZoomScale <= 1) {
            container.classList.remove('pdfPageContainerOverflowX', 'pdfPageContainerOverflowY');
            return;
        }

        const contentSize = this.getRenderedContentSize();

        container.classList.toggle('pdfPageContainerOverflowX', contentSize.width > container.clientWidth);
        container.classList.toggle('pdfPageContainerOverflowY', contentSize.height > container.clientHeight);
    }

    applyZoomTransform() {
        const container = this.mediaElement?.querySelector('.pdfPageContainer');
        if (!container) return;

        container.classList.toggle('pdfPageContainerZoomed', this.zoomScale > 1);
        container.classList.toggle('pdfPageContainerRenderedZoomed', this.renderedZoomScale > 1);
        container.classList.toggle('pdfPageContainerGrabbing', Boolean(this.mousePanGesture));
        container.classList.toggle('pdfPageContainerSpacePan', this.isSpacePressed && this.zoomScale > 1);
        this.updateRenderedZoomAlignment(container);
        container.style.transform = `translate3d(${this.zoomTranslateX}px, ${this.zoomTranslateY}px, 0) scale(${this.zoomScale / this.renderedZoomScale})`;
    }

    resetZoomState() {
        this.zoomScale = 1;
        this.zoomTranslateX = 0;
        this.zoomTranslateY = 0;
        this.renderedZoomScale = 1;
        this.touchGesture = null;
        this.mousePanGesture = null;
        this.isSpacePressed = false;
        this.applyZoomTransform();
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

    onPageAdvanceChanged() {
        this.pdfPlayerSettings.advanceOnePage = !this.pdfPlayerSettings.advanceOnePage;
        this.updatePageAdvanceButton();
    }

    updateColorInversion() {
        const enabled = this.pdfPlayerSettings.invertColors;

        this.mediaElement.classList.toggle('pdfPlayerInvertColors', enabled);

        const button = this.mediaElement.querySelector('.btnToggleColorInversion');
        button.title = enabled ? 'Disable Color Inversion' : 'Invert Colors';
        button.classList.toggle('active', enabled);
        button.setAttribute('aria-pressed', enabled.toString());
    }

    updatePageAdvanceButton() {
        const enabled = this.pdfPlayerSettings.advanceOnePage && this.pdfPlayerSettings.pagesPerView > 1;
        const button = this.mediaElement.querySelector('.btnTogglePageAdvance');

        button.title = enabled ? 'Advance by Spread' : 'Advance One Page';
        button.classList.toggle('active', enabled);
        button.classList.toggle('hide', this.pdfPlayerSettings.pagesPerView <= 1);
        button.setAttribute('aria-pressed', enabled.toString());
    }

    getPageAdvance() {
        return this.pdfPlayerSettings.advanceOnePage && this.pdfPlayerSettings.pagesPerView > 1 ? 1 : this.pdfPlayerSettings.pagesPerView;
    }

    changeView(view) {
        this.resetZoomState();

        const prevIcon = view === 1 ? 'devices_fold' : 'import_contacts';
        this.mediaElement.querySelector('.btnToggleView > span').classList.remove(prevIcon);

        const newIcon = view === 1 ? 'import_contacts' : 'devices_fold';
        this.mediaElement.querySelector('.btnToggleView > span').classList.add(newIcon);

        const viewTitle = view === 1 ? 'Double Page View' : 'Single Page View';
        this.mediaElement.querySelector('.btnToggleView').title = viewTitle;
        this.updatePageAdvanceButton();

        this.pages = {};
        this.loadPage(this.progress + 1);
    }

    bindMediaElementEvents() {
        const elem = this.mediaElement;

        elem.addEventListener('close', this.onDialogClosed, { once: true });
        elem.querySelector('.btnExit').addEventListener('click', this.onDialogClosed, { once: true });
        elem.querySelector('.btnToggleColorInversion').addEventListener('click', this.onColorInversionChanged);
        elem.querySelector('.btnTogglePageAdvance').addEventListener('click', this.onPageAdvanceChanged);
        elem.querySelector('.btnToggleView').addEventListener('click', this.onViewChanged);
        elem.querySelector('.pdfNavButtonNext').addEventListener('click', this.onNextButtonClick);
        elem.querySelector('.pdfNavButtonPrevious').addEventListener('click', this.onPreviousButtonClick);

        const pageContainer = elem.querySelector('.pdfPageContainer');
        pageContainer.addEventListener('wheel', this.onWheel, { passive: false });
        pageContainer.addEventListener('mousedown', this.onMouseDown);
        pageContainer.addEventListener('touchstart', this.onTouchStart, { passive: false });
        pageContainer.addEventListener('touchmove', this.onTouchMove, { passive: false });
        pageContainer.addEventListener('touchend', this.onTouchEnd);
        pageContainer.addEventListener('touchcancel', this.onTouchCancel);
    }

    bindEvents() {
        this.bindMediaElementEvents();

        document.addEventListener('keydown', this.onWindowKeyDown);
        document.addEventListener('keyup', this.onWindowKeyUp);
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
    }

    unbindMediaElementEvents() {
        const elem = this.mediaElement;

        elem.removeEventListener('close', this.onDialogClosed);
        elem.querySelector('.btnExit').removeEventListener('click', this.onDialogClosed);
        elem.querySelector('.btnToggleColorInversion').removeEventListener('click', this.onColorInversionChanged);
        elem.querySelector('.btnTogglePageAdvance').removeEventListener('click', this.onPageAdvanceChanged);
        elem.querySelector('.btnToggleView').removeEventListener('click', this.onViewChanged);
        elem.querySelector('.pdfNavButtonNext').removeEventListener('click', this.onNextButtonClick);
        elem.querySelector('.pdfNavButtonPrevious').removeEventListener('click', this.onPreviousButtonClick);

        const pageContainer = elem.querySelector('.pdfPageContainer');
        pageContainer.removeEventListener('wheel', this.onWheel);
        pageContainer.removeEventListener('mousedown', this.onMouseDown);
        pageContainer.removeEventListener('touchstart', this.onTouchStart);
        pageContainer.removeEventListener('touchmove', this.onTouchMove);
        pageContainer.removeEventListener('touchend', this.onTouchEnd);
        pageContainer.removeEventListener('touchcancel', this.onTouchCancel);
    }

    unbindEvents() {
        if (this.mediaElement) {
            this.unbindMediaElementEvents();
        }

        document.removeEventListener('keydown', this.onWindowKeyDown);
        document.removeEventListener('keyup', this.onWindowKeyUp);
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);
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
            html += '<button is="paper-icon-button-light" class="pdfNavButton pdfNavButtonPrevious" tabindex="-1"><span class="material-icons actionButtonIcon chevron_left" aria-hidden="true"></span></button>';
            html += '<button is="paper-icon-button-light" class="pdfNavButton pdfNavButtonNext" tabindex="-1"><span class="material-icons actionButtonIcon chevron_right" aria-hidden="true"></span></button>';
            html += '<div class="actionButtons">';
            html += '<button is="paper-icon-button-light" class="autoSize btnToggleColorInversion" tabindex="-1"><span class="material-icons actionButtonIcon invert_colors" aria-hidden="true"></span></button>';
            html += '<button is="paper-icon-button-light" class="autoSize btnTogglePageAdvance" tabindex="-1"><span class="material-icons actionButtonIcon looks_one" aria-hidden="true"></span></button>';
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
        this.updatePageAdvanceButton();
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

        const nextProgress = Math.min(this.progress + this.getPageAdvance(), this.duration() - 1);
        this.loadPage(nextProgress + 1);
        this.progress = nextProgress;

        Events.trigger(this, 'pause');
    }

    previous() {
        if (this.progress === 0) return;

        const previousProgress = Math.max(this.progress - this.getPageAdvance(), 0);
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
        this.resetZoomState();

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
                this.pages[page].pdfPageNumber = parseInt(page.slice(4), 10);
                this.renderPage(this.pages[page], parseInt(page.slice(4), 10));
            } else if (this.pages[page].pdfZoomScale !== this.zoomScale) {
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

    renderVisiblePages() {
        const container = this.mediaElement?.querySelector('.pdfPageContainer');
        if (!container) return Promise.resolve();

        const renderTasks = Array.from(container.querySelectorAll('canvas'))
            .map(canvas => this.renderPage(canvas, canvas.pdfPageNumber));

        return Promise.all(renderTasks);
    }

    renderPage(canvas, number) {
        const devicePixelRatio = window.devicePixelRatio || 1;
        const zoomScale = this.zoomScale;
        const previousRenderTask = canvas.renderTask;

        previousRenderTask?.cancel();
        canvas.pdfPageNumber = number;
        canvas.pdfZoomScale = zoomScale;

        const previousRenderPromise = canvas.renderPromise || previousRenderTask?.promise.catch(() => undefined) || Promise.resolve();

        const renderPromise = previousRenderPromise.catch(() => undefined).then(() => this.book.getPage(number)).then(page => {
            const original = page.getViewport({ scale: 1 });
            const pageWidth = window.innerWidth / this.pdfPlayerSettings.pagesPerView;
            const baseScale = Math.min((window.innerHeight / original.height), (pageWidth / original.width));
            const scale = baseScale * devicePixelRatio * zoomScale;
            const viewport = page.getViewport({ scale });

            canvas.width = viewport.width;
            canvas.height = viewport.height;

            canvas.style.width = `${viewport.width / devicePixelRatio}px`;
            canvas.style.height = `${viewport.height / devicePixelRatio}px`;
            canvas.style.maxWidth = zoomScale > 1 ? 'none' : `${100 / this.pdfPlayerSettings.pagesPerView}%`;
            canvas.style.maxHeight = zoomScale > 1 ? 'none' : '100%';

            const context = canvas.getContext('2d');

            const renderContext = {
                canvasContext: context,
                viewport: viewport
            };

            const renderTask = page.render(renderContext);
            canvas.renderTask = renderTask;

            return renderTask.promise.then(() => {
                if (canvas.renderTask === renderTask) {
                    canvas.renderTask = null;
                }

                loading.hide();
            }).catch(error => {
                if (error?.name !== 'RenderingCancelledException') {
                    throw error;
                }
            });
        });

        const queuedRenderPromise = renderPromise.finally(() => {
            if (canvas.renderPromise === queuedRenderPromise) {
                canvas.renderPromise = null;
            }
        });

        canvas.renderPromise = queuedRenderPromise;

        return canvas.renderPromise;
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'book';
    }

    canPlayItem(item) {
        return item.Path ? item.Path.toLowerCase().endsWith('pdf') : false;
    }
}

export default PdfPlayer;
