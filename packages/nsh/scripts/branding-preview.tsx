import { View, mount } from 'nsh';
import { YuriMark, YuriWordmark } from '../branding';

/** Standalone native brand preview; never replaces the application's entrypoint. */
function BrandPreview() {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
    <YuriMark size="hero" decorative testID="brand-mark" />
    <YuriWordmark testID="brand-wordmark" />
  </View>;
}

mount(BrandPreview);
