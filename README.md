# Weather2Grid forecast archive

Archive dashboard and payloads for **older** forecast initializations of
[Weather2Grid](https://github.com/afahadabdullah/weather2grid). The live
dashboard links here through its Archive button and carries only current runs;
this dashboard links back through its Live forecast button.

Published to GitHub Pages under the same account as the dashboard, so it is
same-origin with it and needs no CORS configuration.

The dashboard shell and data are written by
`stormgrid/scripts/publish_weather2grid.sh`. Do not edit them by hand.

**This repository's history is disposable.** Nothing links to its old commits.
When it gets large, run `stormgrid/scripts/init_weather2grid_archive.sh
--reset-history` to collapse it to a single commit.
