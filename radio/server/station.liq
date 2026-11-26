# Prayer Dome Radio — Liquidsoap 2.x AutoDJ
# ---------------------------------------------------------------------------
# Plays the synced music folders on the schedule below (Africa/Lusaka),
# inserts cached AI announcements between tracks, exposes a live harbor
# input for approved presenters, and falls back automatically:
#   live presenter  >  scheduled playlist  >  fallback folder  >  silence-safe
#
# Folders are synced from Cloudflare R2 with radio/server/sync-r2.sh (rclone).
# Icecast credentials come from the environment — nothing is hardcoded.

settings.log.stdout.set(true)
settings.log.level.set(3)

icecast_pass = environment.get("ICECAST_SOURCE_PASSWORD")

# --- Music by programme (synced from R2: radio/music/<category>/) ----------
def folder(p) =
  playlist(mode="randomize", reload=1800, reload_mode="seconds", p)
end

night_worship   = folder("/radio/music/gospel-worship")
morning_prayer  = folder("/radio/music/inspirational")
praise          = folder("/radio/music/praise")
midday_prayer   = folder("/radio/music/traditional")
afternoon       = folder("/radio/music/african-gospel")
evening_worship = folder("/radio/music/gospel-worship")
night_inspire   = folder("/radio/music/instrumental-worship")
fallback_music  = folder("/radio/fallback")

# --- Programme clock (Africa/Lusaka = UTC+2, container TZ should be set) ---
scheduled = switch(track_sensitive=true, [
  ({ 0h-5h },   night_worship),
  ({ 5h-8h },   morning_prayer),
  ({ 8h-12h },  praise),
  ({ 12h-14h }, midday_prayer),
  ({ 14h-18h }, afternoon),
  ({ 18h-21h }, evening_worship),
  ({ 21h-24h }, night_inspire)
])

# --- Cached AI announcements (synced from R2: radio/announcements/) --------
# Roughly one announcement every ~5 tracks; failure never stops the music.
announcements = playlist(mode="randomize", reload=3600, "/radio/announcements")
radio = rotate(weights=[1, 5], [announcements, mksafe(scheduled)])

# --- AutoDJ with fallback ---------------------------------------------------
autodj = fallback(track_sensitive=true, [radio, mksafe(fallback_music)])

# --- Live presenter input ---------------------------------------------------
# The approved presenter connects with a source client (e.g. BUTT/Mixxx) to
# port 8005 using a per-session username/password that the administrator
# issues privately. The main Icecast source password is never shared.
live = input.harbor("live", port=8005, password=icecast_pass)
full = fallback(track_sensitive=false, [live, autodj])

# --- Output to Icecast -------------------------------------------------------
output.icecast(
  %mp3(bitrate=96),
  host="icecast", port=8000,
  password=icecast_pass,
  mount="prayerdome",
  name="Prayer Dome Radio",
  description="A house of prayer for all nations — 24/7 gospel radio",
  genre="Gospel",
  url="https://prayerdome.net/radio.html",
  mksafe(full)
)
