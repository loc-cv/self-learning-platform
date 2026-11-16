grep -v "^  mode: " "$1" > "$1.new"; cp "$1.new" "$1"
