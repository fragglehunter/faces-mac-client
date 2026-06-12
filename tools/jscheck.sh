#!/bin/sh
# Parse-check JS files with JavaScriptCore (no node needed). Usage: tools/jscheck.sh file.js ...
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
cat > /tmp/_jscheck.js <<'JS'
function check(p){ try { new Function(read(p)); print("OK   " + p); } catch(e){ print("FAIL " + p + ": " + e); quit(1); } }
for (var i=0;i<arguments.length;i++) check(arguments[i]);
JS
"$JSC" /tmp/_jscheck.js -- "$@"
