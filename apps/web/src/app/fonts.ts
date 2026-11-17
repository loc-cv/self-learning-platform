// The interface's font, IBM Plex Sans (docs/DESIGN.md §2; kept by the Quiet look, D-132), bundled with the app so it looks the same on every machine and needs no
// network (D-117). Each package's CSS declares its files with unicode ranges (latin, latin-ext,
// vietnamese, …), so the browser loads only the ranges a page uses.

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
