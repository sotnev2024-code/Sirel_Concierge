/**
 * Simple in-memory FSM for Max bot.
 * State is keyed by user_id and persists only while the process is running.
 */

export type StateData = Record<string, string | number>;

export interface UserState {
  state: string;
  data: StateData;
}

const stateMap = new Map<number, UserState>();

export const States = {
  IDLE: 'idle',

  // Waitlist flow
  WAITLIST_NAME: 'waitlist_name',
  WAITLIST_PRIORITY: 'waitlist_priority',
  WAITLIST_PHONE: 'waitlist_phone',

  // Admin flows
  NEWSLETTER_TEXT: 'admin_newsletter_text',
  NEWSLETTER_CATEGORY: 'admin_newsletter_category',
  CHANGE_GUIDE: 'admin_change_guide',
  ADD_PRODUCT_NAME: 'admin_add_product_name',
  ADD_PRODUCT_DESC: 'admin_add_product_desc',
  ADD_PRODUCT_PHOTO: 'admin_add_product_photo',
  EDIT_PRODUCT_NAME: 'admin_edit_product_name',
  EDIT_PRODUCT_DESC: 'admin_edit_product_desc',
  EDIT_PRODUCT_PHOTO: 'admin_edit_product_photo',
  POST_CONTENT: 'admin_post_content',
} as const;

export type StateName = (typeof States)[keyof typeof States];

export function getState(userId: number): UserState {
  return stateMap.get(userId) ?? { state: States.IDLE, data: {} };
}

export function setState(userId: number, state: StateName, data: StateData = {}): void {
  stateMap.set(userId, { state, data });
}

export function updateData(userId: number, extra: StateData): void {
  const current = getState(userId);
  stateMap.set(userId, { ...current, data: { ...current.data, ...extra } });
}

export function clearState(userId: number): void {
  stateMap.delete(userId);
}
