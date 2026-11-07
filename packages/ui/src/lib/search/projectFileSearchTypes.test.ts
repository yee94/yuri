import { expectTypeOf, test } from 'vitest';
import type { opencodeClient, ProjectFileSearchHit as ClientSearchHit } from '../opencode/client';
import type { FileMentionPathHit } from '../../components/chat/fileMentionAutocompleteState';
import type { FileMentionSearchHit } from './fileMentionSearch';
import type { ProjectFileSearchHit } from './projectFileSearchTypes';

test('the client retains its search result type API from the neutral owner', () => {
  expectTypeOf<ClientSearchHit>().toEqualTypeOf<ProjectFileSearchHit>();
  expectTypeOf<Awaited<ReturnType<typeof opencodeClient.searchFiles>>>().toEqualTypeOf<ProjectFileSearchHit[]>();
  expectTypeOf<FileMentionPathHit>().toExtend<ProjectFileSearchHit>();
  expectTypeOf<ProjectFileSearchHit>().toExtend<FileMentionSearchHit>();
  expectTypeOf<ProjectFileSearchHit>().toEqualTypeOf<{
    name: string;
    path: string;
    relativePath: string;
    extension?: string;
    isDirectory?: boolean;
  }>();
});
