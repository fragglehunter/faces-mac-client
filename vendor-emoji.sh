#!/usr/bin/env bash
# vendor-emoji.sh — download emoji art for the non-native themes into
# web/emoji/<theme>/<codepoint>.{png,svg}. Run once (art is committed after).
#
# Coverage (see CLAUDE.md "emoji any-unicode" notes):
#   google / twitter : the FULL Unicode "Smileys & Emotion" group (codepoint-
#                      addressable via emoji-datasource on jsDelivr). At runtime
#                      theme.js also falls back to the CDN for ANY other codepoint.
#   microsoft        : a curated set (Fluent isn't codepoint-addressable from any
#                      CDN and its CLDR folder names don't match emoji-datasource,
#                      so we hardcode names). Other emoji fall back to the native glyph.
#   apple            : the Mac's native system font — no images needed.
#
# Files are saved keyed by the BASE codepoint (variation selectors stripped) to
# match what theme.js computes.
#
# SPDX-License-Identifier: Apache-2.0
set -uo pipefail
cd "$(dirname "$0")"

DS="https://cdn.jsdelivr.net/npm"
API="https://api.github.com/repos/microsoft/fluentui-emoji/contents/assets"
RAW="https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets"

mkdir -p web/emoji/google web/emoji/twitter web/emoji/microsoft

fetch() { # url outfile label
  local url="$1" out="$2" label="$3" code
  code=$(curl -sL -o "$out" -w "%{http_code}" --max-time 30 "$url")
  if [ "$code" = "200" ] && [ -s "$out" ]; then return 0; fi
  rm -f "$out"; [ -n "${label:-}" ] && echo "    miss $label (http $code)"; return 1
}

#############################################################################
# Google + Twitter: full "Smileys & Emotion" group, keyed by base codepoint.
#############################################################################
echo "== Google + Twitter: full Smileys & Emotion group =="
curl -s --max-time 30 "$DS/emoji-datasource@15.1.2/emoji.json" -o /tmp/emoji_ds.json
# Emit "base_cp image has_google has_twitter" for single-codepoint smileys.
python3 - <<'PY' > /tmp/emoji_dl.txt
import json
d=json.load(open('/tmp/emoji_ds.json'))
for e in d:
    if e.get('category')!='Smileys & Emotion': continue
    u=e['unified']
    if '-' in u: continue                # skip sequences/VS (not faces)
    base=u.lower()
    img=e.get('image') or (base+'.png')
    print(base, img, int(bool(e.get('has_img_google'))), int(bool(e.get('has_img_twitter'))))
PY
g=0; t=0
while read -r base img hg ht; do
  [ "$hg" = "1" ] && fetch "$DS/emoji-datasource-google/img/google/64/$img"   "web/emoji/google/$base.png"  "" && g=$((g+1))
  [ "$ht" = "1" ] && fetch "$DS/emoji-datasource-twitter/img/twitter/64/$img" "web/emoji/twitter/$base.png" "" && t=$((t+1))
done < /tmp/emoji_dl.txt
echo "    google: $g   twitter: $t"

#############################################################################
# Microsoft Fluent: curated set (codepoint | CLDR folder name).
#############################################################################
echo "== Microsoft Fluent: curated set =="
MS=(
  "1f603|Grinning face with big eyes"
  "1f634|Sleeping face"
  "1f92c|Face with symbols on mouth"
  "1f92f|Exploding head"
  "1f60d|Smiling face with heart-eyes"
  "1f610|Neutral face"
  "1f644|Face with rolling eyes"
  "1f631|Face screaming in fear"
  "1f92e|Face vomiting"
  "1f615|Confused face"
  "1f914|Thinking face"
  "1f61b|Face with tongue"
  "1f62c|Grimacing face"
  "1f389|Party popper"
  "1f600|Grinning face"
  "1f602|Face with tears of joy"
  "1f642|Slightly smiling face"
  "1f609|Winking face"
  "1f622|Crying face"
  "1f62d|Loudly crying face"
  "1f620|Angry face"
  "1f621|Enraged face"
  "1f618|Face blowing a kiss"
  "1f60e|Smiling face with sunglasses"
  "1f913|Nerd face"
  "1f635|Face with crossed-out eyes"
  "1f632|Astonished face"
  "1f971|Yawning face"
  "1f624|Face with steam from nose"
  "1f637|Face with medical mask"
)
ms=0
for entry in "${MS[@]}"; do
  cp="${entry%%|*}"; name="${entry#*|}"
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$name")
  file=$(printf '%s' "$name" | tr 'A-Z ' 'a-z_')   # lowercase, spaces->_, hyphens kept
  fetch "$RAW/$enc/Color/${file}_color.svg" "web/emoji/microsoft/$cp.svg" "ms:$name" && ms=$((ms+1))
done
echo "    microsoft: $ms / ${#MS[@]}"

echo ""
for t in google twitter microsoft; do
  echo "  $t: $(ls web/emoji/$t 2>/dev/null | wc -l | tr -d ' ') files"
done