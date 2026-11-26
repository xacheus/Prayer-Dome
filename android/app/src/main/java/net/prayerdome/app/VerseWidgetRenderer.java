package net.prayerdome.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.util.Calendar;

/**
 * Builds the RemoteViews for the Prayer Dome verse widget.
 *
 * <p>Everything the widget shows — the living verse of the moment, the reference
 * and the Prayer Dome mark — is assembled here, so the home screen widget, the
 * lock screen panel (Android 15 QPR1 tablets and Android 16 QPR1 phones and
 * later) and the in-app preview at /widgets.html describe the same card.
 *
 * <p>The four themes mirror the theme picker on /widgets.html. A theme is a
 * background drawable plus four text colours, because RemoteViews can only be
 * styled through values set on real views.
 */
final class VerseWidgetRenderer {

    private VerseWidgetRenderer() {
    }

    /** Colours per theme: verse, reference, greeting, brand line. */
    private static final class Theme {
        final int background;
        final int verse;
        final int reference;
        final int greeting;
        final int brand;

        Theme(int background, int verse, int reference, int greeting, int brand) {
            this.background = background;
            this.verse = verse;
            this.reference = reference;
            this.greeting = greeting;
            this.brand = brand;
        }
    }

    private static Theme theme(Context context, String id) {
        switch (id) {
            case VerseWidgetStore.THEME_DOME:
                return new Theme(R.drawable.widget_verse_background_dome,
                        context.getColor(R.color.pd_white),
                        context.getColor(R.color.pd_gold_soft),
                        context.getColor(R.color.pd_blue_light),
                        context.getColor(R.color.pd_white_70));
            case VerseWidgetStore.THEME_DAWN:
                return new Theme(R.drawable.widget_verse_background_dawn,
                        context.getColor(R.color.pd_ink),
                        context.getColor(R.color.pd_rust),
                        context.getColor(R.color.pd_amber_deep),
                        context.getColor(R.color.pd_rust));
            case VerseWidgetStore.THEME_PAPER:
                return new Theme(R.drawable.widget_verse_background_paper,
                        context.getColor(R.color.pd_ink),
                        context.getColor(R.color.pd_navy),
                        context.getColor(R.color.pd_gold_deep),
                        context.getColor(R.color.pd_slate));
            case VerseWidgetStore.THEME_MIDNIGHT:
            default:
                return new Theme(R.drawable.widget_verse_background,
                        context.getColor(R.color.pd_white),
                        context.getColor(R.color.pd_gold_soft),
                        context.getColor(R.color.pd_gold),
                        context.getColor(R.color.pd_blue_light));
        }
    }

    /** The verse the widget shows right now — a pinned verse wins over the rotation. */
    static VerseWidgetData.Verse resolveVerse(Context context, VerseWidgetStore store, Calendar now) {
        VerseWidgetData data = VerseWidgetData.get(context);
        if (store.isPinned()) {
            return new VerseWidgetData.Verse(store.pinnedReference(), store.pinnedText());
        }
        if (!data.isVerified()) {
            // The packaged data and the website library disagree: show the
            // static fallback rather than a verse nobody approved.
            return data.fallback();
        }
        return data.currentVerse(now);
    }

    static RemoteViews build(Context context, VerseWidgetStore store, Calendar now) {
        return build(context, store, now, null);
    }

    /**
     * Build a card for the actual size Android gave this instance. Launchers
     * resize widgets between 180×70dp and 460×280dp, so one fixed type scale
     * either clips long verses on a small widget or looks tiny on a large one.
     */
    static RemoteViews build(Context context, VerseWidgetStore store, Calendar now, Bundle options) {
        VerseWidgetData data = VerseWidgetData.get(context);
        VerseWidgetData.Verse verse = resolveVerse(context, store, now);
        VerseWidgetData.Slot slot = data.currentSlot(now);
        Theme theme = theme(context, store.theme());

        int width = option(options, AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 320);
        int height = option(options, AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 180);
        boolean compact = width < 260 || height < 130;
        boolean roomy = height >= 220 && width >= 300;
        float scale = store.textScale();
        float verseSp = (compact ? 13f : roomy ? 17f : 15f) * scale;
        float refSp = (compact ? 10.5f : 12f) * scale;
        int padDp = compact ? 10 : roomy ? 20 : 16;
        int padding = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, padDp,
                context.getResources().getDisplayMetrics());
        int maxLines = compact ? 5 : roomy ? 12 : 8;

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.verse_widget);
        views.setInt(R.id.widgetCard, "setBackgroundResource", theme.background);
        views.setViewPadding(R.id.widgetCard, padding, padding, padding, padding);
        views.setTextViewText(R.id.widgetVerse, verse.text);
        views.setTextViewText(R.id.widgetReference, "— " + verse.reference);
        views.setInt(R.id.widgetVerse, "setMaxLines", maxLines);

        views.setTextViewTextSize(R.id.widgetVerse, TypedValue.COMPLEX_UNIT_SP, verseSp);
        views.setTextViewTextSize(R.id.widgetReference, TypedValue.COMPLEX_UNIT_SP, refSp);
        views.setTextViewTextSize(R.id.widgetGreeting, TypedValue.COMPLEX_UNIT_SP, compact ? 10f : 11f);
        views.setTextViewTextSize(R.id.widgetBrandText, TypedValue.COMPLEX_UNIT_SP, compact ? 8f : 9f);
        views.setTextColor(R.id.widgetVerse, theme.verse);
        views.setTextColor(R.id.widgetReference, theme.reference);

        String label = store.isPinned() ? store.pinnedLabel() : "";
        String greeting = store.isPinned()
                ? (label.isEmpty() ? "Pinned verse" : label)
                : slot.greeting;
        views.setTextViewText(R.id.widgetGreeting, greeting);
        views.setTextColor(R.id.widgetGreeting, theme.greeting);
        views.setViewVisibility(R.id.widgetGreeting, store.showGreeting() ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widgetReference, store.showReference() ? View.VISIBLE : View.GONE);
        // On a very small widget the brand gives way to Scripture, but a pinned
        // verse keeps its label because that is what the member chose to see.
        boolean showBrand = store.showBrand() && (!compact || store.isPinned());
        views.setViewVisibility(R.id.widgetBrandRow, showBrand ? View.VISIBLE : View.GONE);
        views.setTextColor(R.id.widgetBrandText, theme.brand);
        views.setImageViewResource(R.id.widgetBrandIcon, R.mipmap.ic_launcher);

        // Screen readers should hear the reference as well as the text.
        views.setCharSequence(R.id.widgetVerse, "setContentDescription",
                "Scripture " + verse.reference + ": " + verse.text);
        views.setCharSequence(R.id.widgetCard, "setContentDescription",
                "Prayer Dome daily verse. Tap to open the verse studio.");

        // Tapping the card opens the app at the verse studio; the refresh icon
        // re-reads the clock and redraws without leaving the lock screen.
        views.setOnClickPendingIntent(R.id.widgetCard, openApp(context));
        views.setOnClickPendingIntent(R.id.widgetRefresh, refresh(context));
        return views;
    }

    private static int option(Bundle options, String key, int fallback) {
        if (options == null) return fallback;
        int value = options.getInt(key, fallback);
        return value > 0 ? value : fallback;
    }

    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("https://prayerdome.net/widgets"));
        intent.putExtra("pd_route", "/widgets.html");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 100, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent refresh(Context context) {
        Intent intent = new Intent(context, VerseWidgetProvider.class);
        intent.setAction(VerseWidgetProvider.ACTION_REFRESH);
        return PendingIntent.getBroadcast(context, 101, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Redraw every placed widget (called by the provider, the alarm and the app). */
    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new android.content.ComponentName(context, VerseWidgetProvider.class));
        if (ids.length == 0) return;
        VerseWidgetStore store = VerseWidgetStore.get(context);
        Calendar now = Calendar.getInstance();
        for (int id : ids) {
            Bundle options = manager.getAppWidgetOptions(id);
            manager.updateAppWidget(id, build(context, store, now, options));
        }
    }
}
