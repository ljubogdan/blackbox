import { defineRuntime, SemanticEvent } from '@mozaik-ai/core';
import type { CaseFile } from '../shared/types';
import { BlackboxState, push } from './state';

export const { initializeRuntime, resolveRuntime, join, sendEvent, runLoop } = defineRuntime<BlackboxState>();

export const state = () => resolveRuntime().state;

export function publish(type: string, senderId: string, payload: Record<string, unknown>) {
  sendEvent(SemanticEvent.create(type, senderId, payload), senderId);
}

export function note(c: CaseFile, who: string, text: string) {
  c.log.push({ t: Date.now(), who, text });
  if (c.log.length > 60) c.log.shift();
}

// Send the current case file to the browser. The truth is attached only once closed.
export function pushCase(c: CaseFile) {
  push({ type: 'case', case: c });
}
