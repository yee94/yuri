// Dev-only entry: same production Root with the in-process mock host, for
// `nsh run/test app/dev --target ios` (device dev hosts have no page host).
import { installDevHost, devHostEmit } from '../core/host';
import { createHost } from './host';

installDevHost(createHost({ hostEvent: devHostEmit }));

import { mount } from 'nsh';
import { Root } from '../shell/Root';

mount(Root);
