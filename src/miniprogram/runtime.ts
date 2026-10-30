// One shared bundle keeps the demo engine and validators out of per-page bundles.
export { call, ClientError, getMode, setMode, requestModeSwitch, uniqueId, toast, readableTime, resetDemo, getListSignal } from './services/api';
export { SCENES, TONES, POLICY_VERSION, labelledText } from '../shared/contracts';
export { PERSONALITIES, CLOSENESS, EMOTIONS, CONTEXT_LIMITS, MEMORY_SUBJECTS, MEMORY_DURATIONS, MEMORY_KINDS, rolePreferences, memoryActive, memoryConflict, referenceQuality, IMPORT_LIMITS, parseReference, displayChatText, referenceCaption, utf8Bytes, referencePreview, reviewedReferenceText, redactPrivate } from '../shared/companion';
export { analyzeImport, reviewImport, validateImportReview } from '../shared/import-cleaning';
export { SCREENSHOT_LIMITS, screenshotTiles, screenshotTurns } from '../shared/screenshot';
export { INITIATIVE_LIMITS, INTERACTION_LABELS, naturalBubbles } from '../shared/interaction';
export { beijingClock } from '../shared/beijing-time';
