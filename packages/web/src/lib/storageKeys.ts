/** Централизованный реестр ключей localStorage: защита от коллизий и удобный поиск. */
export const STORAGE_KEYS = {
  SELECTED_PROJECT: "aif-selected-project",
  DENSITY: "aif-density",
  VIEW_MODE: "aif-view-mode",
  LIST_QUERY: "aif-list-query",
  LIST_SORT: "aif-list-sort",
  THEME: "aif-theme",
  NOTIFICATION_SETTINGS: "aif-notification-settings",
} as const;
