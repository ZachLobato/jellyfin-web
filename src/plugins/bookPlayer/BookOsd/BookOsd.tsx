import React, { type FC, useCallback, useEffect, useState } from 'react';

import './BookOsd.scss';
import IconButton from '../../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';

interface BookOsdProps {
    title: string;
    onExit: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onOpenTableOfContents?: () => void;
    onRotateTheme?: () => void;
    onDecreaseFontSize?: () => void;
    onIncreaseFontSize?: () => void;
    onToggleFullscreen?: () => void;
    onStartReadingHere?: () => void;
    onResumeFromSaved?: () => void;
    onStopReading?: () => void;
    onPauseReading?: () => void;
    onResumeReading?: () => void;
    onJumpBack?: () => void;
    onJumpForward?: () => void;
    onRegisterStopHandler?: (handler: () => void) => void;
    onRegisterPageUpdateHandler?: (handler: (current: number, total: number) => void) => void;
}

const BookOsd: FC<BookOsdProps> = ({
    title,
    onExit,
    onPrevious,
    onNext,
    onOpenTableOfContents,
    onRotateTheme,
    onDecreaseFontSize,
    onIncreaseFontSize,
    onToggleFullscreen,
    onStartReadingHere,
    onResumeFromSaved,
    onStopReading,
    onPauseReading,
    onResumeReading,
    onJumpBack,
    onJumpForward,
    onRegisterStopHandler,
    onRegisterPageUpdateHandler
}) => {
    const [fullscreen, setFullscreen] = useState(false);
    const [controlsShown, setControlsShown] = useState(false);
    const [reading, setReading] = useState(false);
    const [paused, setPaused] = useState(false);
    const [currentPage, setCurrentPage] = useState(0);
    const [totalPages, setTotalPages] = useState(0);

    const onClickFullscreen = useCallback(() => {
        onToggleFullscreen?.();
        setFullscreen(state => !state);
    }, [onToggleFullscreen]);

    const onClickRead = useCallback(() => {
        if (reading) {
            onStopReading?.();
            setReading(false);
            setPaused(false);
            setControlsShown(false);
        } else if (controlsShown) {
            setControlsShown(false);
        } else {
            setControlsShown(true);
        }
    }, [reading, controlsShown, onStopReading]);

    const onClickPlay = useCallback(() => {
        onStartReadingHere?.();
        setReading(true);
        setPaused(false);
    }, [onStartReadingHere]);

    const onClickResume = useCallback(() => {
        onResumeFromSaved?.();
        setReading(true);
        setPaused(false);
    }, [onResumeFromSaved]);

    const onClickPauseResume = useCallback(() => {
        if (paused) {
            onResumeReading?.();
            setPaused(false);
        } else {
            onPauseReading?.();
            setPaused(true);
        }
    }, [paused, onPauseReading, onResumeReading]);

    useEffect(() => {
        onRegisterStopHandler?.(() => {
            setReading(false);
            setPaused(false);
            setControlsShown(true);
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        onRegisterPageUpdateHandler?.((current, total) => {
            setCurrentPage(current);
            setTotalPages(total);
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const hasTts = onStartReadingHere != null;

    return (
        <div className='bookOsd'>
            <div className='bookOsdRow bookOsdTop'>
                <IconButton onClick={onExit} icon='arrow_back' title={globalize.translate('ButtonBack')} />
                <span className='bookOsdTitle'>{title}</span>
                {totalPages > 0 && (
                    <span className='bookOsdPage'>{currentPage} / {totalPages}</span>
                )}
            </div>

            <div className='bookOsdBottomGroup'>
                {controlsShown && !reading && (
                    <div className='bookOsdRow bookOsdTtsControls'>
                        <IconButton
                            onClick={onClickPlay}
                            icon='play_circle'
                            title='Start reading this page'
                        />
                        <IconButton
                            onClick={onClickResume}
                            icon='replay'
                            title='Resume last position'
                        />
                    </div>
                )}

                {reading && (
                    <div className='bookOsdRow bookOsdTtsControls'>
                        <IconButton
                            onClick={onJumpBack}
                            icon='fast_rewind'
                            title='Previous sentence'
                        />
                        <IconButton
                            onClick={onClickPauseResume}
                            icon={paused ? 'play_arrow' : 'pause'}
                            title={paused ? 'Resume' : 'Pause'}
                        />
                        <IconButton
                            onClick={onJumpForward}
                            icon='fast_forward'
                            title='Next sentence'
                        />
                    </div>
                )}

                <div className='bookOsdRow bookOsdBottom'>
                    <IconButton onClick={onPrevious} icon='navigate_before' title={globalize.translate('Previous')} />
                    <IconButton onClick={onNext} icon='navigate_next' title={globalize.translate('Next')} />

                    {onOpenTableOfContents && (
                        <IconButton
                            onClick={onOpenTableOfContents}
                            icon='toc'
                            title={globalize.translate('TableOfContents')}
                        />
                    )}

                    {onRotateTheme && (
                        <IconButton
                            onClick={onRotateTheme}
                            icon='remove_red_eye'
                            title={globalize.translate('LabelTheme')}
                        />
                    )}

                    {onDecreaseFontSize && (
                        <IconButton
                            onClick={onDecreaseFontSize}
                            icon='text_decrease'
                            title={globalize.translate('Smaller')}
                        />
                    )}

                    {onIncreaseFontSize && (
                        <IconButton
                            onClick={onIncreaseFontSize}
                            icon='text_increase'
                            title={globalize.translate('Larger')}
                        />
                    )}

                    {hasTts && (
                        <IconButton
                            onClick={onClickRead}
                            icon={controlsShown ? 'volume_off' : 'volume_up'}
                            title={controlsShown ? 'Hide reading controls' : 'Read Aloud'}
                        />
                    )}

                    {onToggleFullscreen && (
                        <IconButton
                            onClick={onClickFullscreen}
                            icon={fullscreen ? 'fullscreen_exit' : 'fullscreen'}
                            title={globalize.translate(fullscreen ? 'ExitFullscreen' : 'Fullscreen')}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

export default BookOsd;
