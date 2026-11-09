/** Public source ports. The original state owner imports the pure projection leaf, never this barrel. */
export { createDesktopWorkStatusSourceProjection, desktopWorkStatusSourcePartID } from './desktop-work-status-source-projection';
export { readChatWorkStatusChildren as readDesktopWorkStatusChildren } from './state';
export { observeChatWorkStatusChildren as observeDesktopWorkStatusChildren } from './state';
