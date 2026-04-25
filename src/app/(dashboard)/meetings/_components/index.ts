/**
 * Barrel for the meeting-insights _components folder.
 *
 * Stream A imports `AttachmentBlock` from this stable path so the
 * concrete file location can move (e.g. when the message page grows
 * additional shared components) without breaking the import.
 */
export { AttachmentBlock, type AttachmentBlockProps } from "./AttachmentBlock";
