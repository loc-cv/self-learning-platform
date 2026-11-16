grep -v "^  name: settings$" "$1" > "$1.new"; cp "$1.new" "$1"
