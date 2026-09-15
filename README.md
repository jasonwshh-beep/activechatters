# Kick Active Chatter Giveaway

Railway-ready giveaway app that picks a random Kick viewer who sent any chat message during the rolling last five minutes. A viewer's five-minute eligibility refreshes whenever they chat again.

## Railway setup

Upload this entire folder to GitHub, deploy that repository on Railway, and add these variables:

```env
KICK_CHANNEL=w
ADMIN_PIN=1234
KICK_CHATROOM_ID=
CHANNEL_AVATAR_URL=
```

- `KICK_CHANNEL`: channel name only, without `@` or `kick.com/`.
- `ADMIN_PIN`: PIN used by the private dashboard controls.
- `KICK_CHATROOM_ID`: normally blank. If Railway cannot resolve Kick automatically, enter the numeric chatroom ID.
- `CHANNEL_AVATAR_URL`: optional direct image URL for the default overlay avatar.
- Railway supplies `PORT` automatically; do not set it yourself.

## URLs

- `/` — private dashboard used to roll, test, and clear the active pool.
- `/overlay` — OBS Browser Source.

Use **500 × 164** as the OBS Browser Source size. The surrounding page is transparent.

## Behavior

- Every real, non-empty Kick chat message makes that username eligible.
- Repeat messages refresh that person's activity time but never create duplicate entries.
- Viewers expire automatically exactly five minutes after their latest message.
- A roll freezes the current eligible list, chooses on the server, and runs a five-second animation.
- The bottom overlay clock displays the rolling window and countdown until the next chatter expires.
- The dashboard continues showing the winner's later messages for verification.
- Manual test chatters also expire after five minutes.

The active pool is held in memory. A Railway restart starts with an empty pool, which is appropriate because nobody from before the restart can be confirmed as active within the new five-minute window.
