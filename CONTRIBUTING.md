# Contributing

Thanks for helping. A few notes:

- Run `npm install`, then `npm run dev`, and test in Chrome or Edge.
- Run `npx tsc --noEmit` before opening a pull request.
- Keep everything client side. Pauseless must never upload media or call a server.
- Keep the app fast: analysing a 1 hour file should stay around 10 seconds.
- If you change `src/engine/mel.ts`, change `training/mel.py` the same way and retrain the model.
- Please do not commit media files or recordings.

Bug reports are most useful with the browser version, the operating system, and where the file
came from (camera, Riverside, OBS...). Do not attach private recordings.
