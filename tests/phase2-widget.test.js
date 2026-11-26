'use strict';

/*
 * Phase 2 widget improvements, checked without an Android SDK:
 * adaptive RemoteViews rendering, honest preview, one widget system and the
 * battery-friendly four-alarm schedule.
 *
 * Run: node tests/phase2-widget.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
let passed = 0;
function t(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS  ' + name); }
  else { console.error('FAIL  ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1; }
}

const javaDir = path.join(ROOT, 'android/app/src/main/java/net/prayerdome/app');
const renderer = fs.readFileSync(path.join(javaDir, 'VerseWidgetRenderer.java'), 'utf8');
const provider = fs.readFileSync(path.join(javaDir, 'VerseWidgetProvider.java'), 'utf8');
const scheduler = fs.readFileSync(path.join(javaDir, 'VerseWidgetScheduler.java'), 'utf8');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const widgetInfo = read('android/app/src/main/res/xml/verse_widget_info.xml');
const preview = read('android/app/src/main/res/layout/verse_widget_preview.xml');
const studio = read('widgets.html');
const bridge = read('assets/pd-widget.js');

/* ---------------------------------------------------------- adaptive design */
t('the renderer has a size-aware build overload',
  /static RemoteViews build\(Context context, VerseWidgetStore store, Calendar now, Bundle options\)/.test(renderer) &&
  renderer.includes('OPTION_APPWIDGET_MAX_WIDTH') && renderer.includes('OPTION_APPWIDGET_MAX_HEIGHT'));
t('small, standard and roomy widgets get different type, padding and line limits',
  renderer.includes('boolean compact = width < 260 || height < 130') &&
  renderer.includes('boolean roomy = height >= 220 && width >= 300') &&
  renderer.includes('views.setViewPadding(') &&
  renderer.includes('views.setInt(R.id.widgetVerse, "setMaxLines", maxLines)'));
t('the brand yields to Scripture on a small card but a pinned label is kept',
  renderer.includes('boolean showBrand = store.showBrand() && (!compact || store.isPinned())') &&
  renderer.includes('String label = store.isPinned() ? store.pinnedLabel() : ""'));
t('the card exposes its contents to screen readers',
  renderer.includes('"setContentDescription"') &&
  renderer.includes('"Scripture " + verse.reference + ": " + verse.text'));
t('the provider redraws each instance with its own size options',
  provider.includes('manager.getAppWidgetOptions(appWidgetId)') &&
  provider.includes('VerseWidgetRenderer.build(context, store, now,'));
t('APPWIDGET_UPDATE still reaches onUpdate instead of being swallowed',
  provider.includes('if (AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action)) {') &&
  /super\.onReceive\(context, intent\);\n            return;/.test(provider));
t('resize events rebuild from the new Bundle',
  provider.includes('onAppWidgetOptionsChanged') &&
  provider.includes('Calendar.getInstance(), options'));
t('the alarm redraw uses the same size-aware path',
  renderer.includes('Bundle options = manager.getAppWidgetOptions(id)'));

/* ---------------------------------------------------------- honest preview */
t('the widget picker preview quotes NIV, not the old KJV wording',
  preview.includes('Psalm 46:10, NIV') && !preview.includes('heathen'));
t('the studio can preview small, standard and large widget sizes',
  studio.includes('id="vwSize"') &&
  studio.includes('<option value="compact">') &&
  studio.includes('<option value="roomy">'));
t('the web preview uses the same adaptive type and padding rules',
  bridge.includes('function renderCard(host, verse, prefs, size)') &&
  bridge.includes('var base = size === \'compact\' ? 13 : size === \'roomy\' ? 17 : 15') &&
  studio.includes('widget().renderCard(host, previewVerse(), state.prefs, size)'));

/* ------------------------------------------------ one system, low power */
t('all four themes, pinning, refresh and notification times remain in the studio',
  ['vwTheme', 'vwScale', 'vwGreeting', 'vwReference', 'vwBrand', 'vwRefresh', 'vwUnpin',
    'vwPinSelected', 'data-pd-verse-settings'].every((id) => studio.includes(id)));
t('the widget remains a single home-screen and keyguard provider',
  (manifest.match(/<receiver\s+android:name="\.VerseWidgetProvider"/g) || []).length === 1 &&
  /android:widgetCategory="home_screen\|keyguard"/.test(widgetInfo));
t('the schedule still uses only four idle-friendly boundaries',
  scheduler.includes('setAndAllowWhileIdle') &&
  read('android/app/src/main/java/net/prayerdome/app/VerseWidgetData.java').includes('DEFAULT_BOUNDARIES = {0, 11, 14, 18}'));
t('the packaged library bundle was regenerated from one source',
  read('scripts/build-widget-verses.mjs').includes('pd_widget_verses.json') &&
  JSON.parse(read('android/app/src/main/res/raw/pd_widget_verses.json')).source === 'assets/pd-verse-data.js');

console.log(`\n${passed} phase 2 widget assertions passed.`);
