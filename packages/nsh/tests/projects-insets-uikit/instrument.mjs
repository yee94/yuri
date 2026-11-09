export function instrumentProjects(original, marker) {
  const start = original.indexOf('export function ProjectsHome('), end = original.indexOf('export function ProjectDetail(', start);
  if (start < 0 || end < 0) throw new Error('ProjectsHome boundary missing');
  let home = original.slice(start, end);
  const replace = (before, after) => { if (home.split(before).length !== 2) throw new Error('Expected exactly one ProjectsHome seam: ' + before); home = home.replace(before, after); };
  replace('  const scroll = createProjectsScroll();', `  markLayoutConsumer(${JSON.stringify(marker)});\n  const scroll = createProjectsScroll();`);
  replace('return <View class="flex-1 bg-background">', 'return <View testID="production-root" ref={layoutRef("production-root")} onLayout={event => layoutEvent("production-root", event)} class="flex-1 bg-background"><LayoutProbe name="production-root" />');
  replace('ref={scroll.ref}', 'ref={node => { scroll.ref(node); layoutRef("production-scroll")(node); }} onLayout={event => layoutEvent("production-scroll", event)}');
  replace('<View style={{ maxWidth: 452, width: \'100%\', alignSelf: \'center\' }}>', '<View testID="production-shell" ref={layoutRef("production-shell")} onLayout={event => layoutEvent("production-shell", event)} style={{ maxWidth: 452, width: \'100%\', alignSelf: \'center\' }}><LayoutProbe name="production-shell" />');
  replace('<View ref={scroll.contentRef} onLayout={scroll.onContentLayout}', '<View testID="production-content" ref={node => { scroll.contentRef(node); layoutRef("production-content")(node); }} onLayout={event => { scroll.onContentLayout(); layoutEvent("production-content", event); }}');
  replace('<View testID={`projects-card-${project().id}`} style={projectHomeSurface}>', '<View testID={`projects-card-${project().id}`} ref={layoutRef(`projects-card-${project().id}`)} onLayout={event => layoutEvent(`projects-card-${project().id}`, event)} style={projectHomeSurface}><LayoutProbe name={`projects-card-${project().id}`} />');
  replace('gap: homeGeometry().pageGap }}>','gap: homeGeometry().pageGap }}><LayoutProbe name="production-content" />');
  replace('<View class="flex-row items-center gap-3 pt-3 pb-1 px-1"', '<View testID="production-toolbar" ref={layoutRef("production-toolbar")} onLayout={event => layoutEvent("production-toolbar", event)} class="flex-row items-center gap-3 pt-3 pb-1 px-1"');
  replace('paddingHorizontal: 4 * nativeDensity().scale }}>','paddingHorizontal: 4 * nativeDensity().scale }}><LayoutProbe name="production-toolbar" />');
  return "import { LayoutProbe, layoutRef, layoutEvent, markLayoutConsumer } from './tests/projects-insets-uikit/probe';\n" + original.slice(0, start) + home + original.slice(end);
}

export function instrumentHome(original) {
  const start = original.indexOf('function Home() {'), end = original.indexOf('function NativeRetentionRoot(', start);
  if (start < 0 || end < 0) throw new Error('Home boundary missing');
  let home = original.slice(start, end);
  const replace = (before, after) => { if (home.split(before).length !== 2) throw new Error('Expected exactly one Home seam: ' + before); home = home.replace(before, after); };
  replace('<View class="flex-1" style={{ paddingTop: safeArea().top, paddingLeft: safeArea().left, paddingRight: safeArea().right }}>', '<View testID="home-safe-area" ref={layoutRef("home-safe-area")} onLayout={event => layoutEvent("home-safe-area", event)} class="flex-1" style={{ paddingTop: safeArea().top, paddingLeft: safeArea().left, paddingRight: safeArea().right }}><LayoutProbe name="home-safe-area" />');
  replace('<If when={!!app.connection()}>\n        <View class="flex-1">', '<If when={!!app.connection()}>\n        <View testID="home-connected" ref={layoutRef("home-connected")} onLayout={event => layoutEvent("home-connected", event)} class="flex-1"><LayoutProbe name="home-connected" />');
  replace('<View class="flex-1 flex-col" style={{ display: app.tab() === 0 ? \'flex\' : \'none\' }}>', '<View testID="home-projects-tab" ref={layoutRef("home-projects-tab")} onLayout={event => layoutEvent("home-projects-tab", event)} class="flex-1 flex-col" style={{ display: app.tab() === 0 ? \'flex\' : \'none\' }}><LayoutProbe name="home-projects-tab" />');
  return "import { LayoutProbe, layoutRef, layoutEvent } from './tests/projects-insets-uikit/probe';\n" + original.slice(0, start) + home + original.slice(end);
}
