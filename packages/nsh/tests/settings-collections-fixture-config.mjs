import { prepareSettingsEngineFixture } from './settings-engine-fixture-runner.mjs';

/** Runner-side configuration only; never loaded by NSH's web Host or production. */
export function prepareCollectionsFixture(root, directory) {
  return prepareSettingsEngineFixture(root, directory, 'settings-collections-fixture.tsx', 'tests/settings-collections-host.js', ['collections.fixture.audit']);
}
