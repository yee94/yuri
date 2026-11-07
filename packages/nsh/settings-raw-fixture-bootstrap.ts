import { captureHostOperation, loadConnections } from './state';

/** Test fixtures use the real root adoption path, never hand-set app authority. */
export async function admitSettingsFixture() {
  await loadConnections();
  const operation = captureHostOperation();
  if (!operation.current() || !operation.scope) throw new Error('synthetic_settings_scope_not_admitted');
  return operation;
}
