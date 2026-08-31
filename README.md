# Good Words

A 5×5 word game. Find as many words as you can in three minutes, then spend the
thirty-second break reading the definitions of the good words you missed.

An implementation of [Tony's Good Words spec](https://tk.xyz/libraries/d2a9920a-6d24-4603-a6a7-d425db609e1f/notes/271ebdcc-3085-4494-8f65-a7444fe1c425):
the three columns, a live leaderboard, and definitions of the words you missed.
Everyone plays the same board on the same schedule. No accounts — type a name and
play. If there is no room to join, the game falls back to solo and still works.

## How it stays in sync

Rounds are global and derived from the clock:

    round = floor(unixTimeMs / 210000)

**Solo**, that is the whole story. The board is a pure function of the round
number, so anyone loading the page in the same 210-second window sees the same
board with nothing coordinating them. The dictionary and definitions are static
files and history lives in `localStorage`, so the game works with no server at
all — and still does, if the room cannot be reached.

**Multiplayer** cannot use that board, because a board derivable from the clock
can be solved before it is played. So the server rolls a board from
`crypto.getRandomValues` and pushes it when the round starts. It also keeps its
own solution and re-checks every word: the browser validates too, for instant
feedback with no round trip, but nothing a client claims is taken on trust.

Every clock update re-reads `Date.now()` rather than counting elapsed ticks, so
the countdown cannot drift. That matters because browsers make timers unreliable
on purpose: intervals are throttled to once a second in a hidden tab, once a
minute after a few minutes there, and stop entirely while a laptop sleeps. The
clock is also re-read on `visibilitychange`, `focus` and `pageshow`, so it is
correct the instant the tab is visible rather than after the next throttled tick.
Multiplayer additionally corrects for this browser's clock being wrong, using the
server timestamp on every board.

## The room

One Durable Object, `GameRoom`, holds every player.

It is deliberately **not** one room per round. Rounds are globally synchronised,
so every player is in the same round at the same moment — a room per round would
buy no parallelism, and would make every client reconnect simultaneously on each
boundary. Instead one long-lived room pushes a new board each round, driven by an
alarm set to the next boundary.

The room keeps its state in memory. There is exactly one active room, so it costs
a few dollars a month to leave running, and hibernation would mean rebuilding
that state from storage on every message for no benefit.

To grow past what one object can broadcast, shard players across several rooms and
add a per-round aggregator that merges their top scores. Nothing in the protocol
has to change. The broadcast is already coalesced to about one leaderboard a
second rather than one per word found, and the standings are serialised once per
broadcast rather than once per socket — those two are what would bite first.

## How many players

`npm run loadtest` holds N sockets open and submits real words off the dealt board
at a brisk human pace. Measured against a local worker, so treat the shape as the
finding and the absolute numbers as indicative:

    players   p50    p95    p99     dropped
        50    8ms   13ms   14ms       none
       200   14ms   25ms   27ms       none
       500   35ms   55ms   57ms       none
      1000   46ms   68ms   72ms       none
      2000  103ms  170ms  187ms       none

Round trip grows about linearly with the number of connected players, which is
what a single room broadcasting to everyone should do. Nothing dropped, every word
scored, and the leaderboard kept its cadence throughout.

Latency here is *only* the leaderboard. A word is validated in the browser and
appears at once; the room's reply changes nothing the player sees. So the ceiling
is set by how stale a leaderboard may be, not by how the game feels — which is
why a few hundred milliseconds is survivable.

On that basis: comfortable to a couple of thousand, probably usable to around five
with a visibly laggier leaderboard, and past that the sharding above is the answer.
A durable object also caps at 32,768 sockets and 128 MB, neither of which was in
reach at 2,000.

### On real infrastructure

`npm run deploy:loadtest` publishes the same code as `goodwords-loadtest`, which
gets its own durable object namespace, so bots never reach the real standings.
Then:

    LOAD_WS=wss://goodwords-loadtest.<subdomain>.workers.dev \
    LOAD_HTTP=https://goodwords-loadtest.<subdomain>.workers.dev \
    PLAYERS=1000 npm run loadtest

Measured from one laptop on the US west coast against a room pinned to
`enam`:

    players   p50    p95     p99    dropped
         1    82ms   87ms    87ms     none     <- network floor, no room work
       200   120ms  175ms   186ms     none
       500   271ms  601ms   873ms     none
      1000   248ms  632ms   980ms     none
      2000   346ms  948ms  1178ms     none

Two thousand sockets, nothing dropped, every word scored, and the leaderboard kept
its cadence. Take the tail with caution: two thousand TLS sessions from a single
machine and a single IP is itself heavy — the ramp alone took 6.8 seconds — and
real players arrive from many addresses and many colos.

The interesting result is a diagnostic. Running a thousand players at a quarter of
the word rate did not improve latency at all (p50 330ms against 248ms). The cost
tracks the number of *connections*, not the number of words, which is what a room
broadcasting to everyone should do, and it says the room is nowhere near limited
by validating words.

The 82ms floor is worth naming: one global room lives in one place, so a global
leaderboard has an irreducible latency set by distance to it. That is the price of
everyone sharing a board, not something to tune away.

And again, this latency is only the leaderboard. Words are validated in the browser
and appear at once.

### Where it breaks

`npm run loadbig` forks a client process per 1,500 sockets, because one Node
process is the thing being measured past about two thousand. It reports close
codes, and reads the room's own `/api/stats` while the load is on.

Against the edge, the room held **about 2,900 sockets** with its broadcast cadence
back on its 750ms target and a 190–230ms median. Past that, connections died with
close code **1006** — an abnormal close with no close frame. The room never refused
anyone; those were dropped below the application.

Connection *rate* turned out to matter far more than connection *count*. The same
five thousand players arriving in a burst left 107 survivors; arriving at about two
hundred a second left 2,900.

The reason is the one documented limit that binds here: a Durable Object has a
[soft limit of 1,000 requests per second](https://developers.cloudflare.com/durable-objects/platform/limits/),
and an inbound WebSocket message is a request. There is **no documented cap on
WebSocket connections per object** — the ceiling is message rate, not sockets.

That arithmetic matches every measurement:

- a burst of 5,000 connections is 5,000 requests in a couple of seconds, far past
  1,000/s, so most are shed — which is exactly what 1006 looks like
- 2,900 players at a word every 4s is ~725 requests/s, just under, and it held
- a player finding twenty words in a three-minute round averages one word per nine
  seconds, or 0.11 requests/s

So on **one room**: roughly **9,000 players at a realistic pace**, ~4,000 at the
brisk rate this harness uses. Broadcasts do not count against it — they are
outgoing — and CPU was not the binding constraint at 2,900.

Beyond that, shard. At ~9,000 per room, 20,000 needs three rooms and 100,000 needs
a dozen, each with a per-round aggregator merging their top scores — which is the
design already sketched above. 100,000 in a single room is not a tuning problem; it
is about eleven times a documented limit.

What is *not* measured: 10,000 and beyond. One laptop on one IP cannot generate it —
the failures above are transport-level drops, not the room saying no. Doing it
properly needs load generated from several machines.

A round's own scores never leave memory: they are worthless thirty seconds later.
The rolling day is the one thing that outlives a round, and it lives in the
object's own SQLite — two small tables, no separate database. Rows older than
twenty-four hours are deleted whenever the standings are read.

A finished round is filed when the next board is dealt, and also when a player
disconnects, so closing the tab mid-round does not throw the score away. Both
writes are keyed on round and player, so recording twice is harmless.

## Deploying during a game

Publishing restarts the durable object and closes every socket with it, which lands
on whoever is playing. Three things make that survivable, and `npm test` includes a
test that stops the worker mid-round and restarts it.

The round's board is written down when it is rolled and reused if the round has
already begun, so a restart deals the same board rather than a new one. Losing the
socket does not drop that board either — the browser keeps playing it and shows
"reconnecting" rather than falling back to a solo board, which would change the
board mid-round. And on rejoining, the browser plays its words back to the room, so
a leaderboard that restarted empty fills in again.

The gap is the thirty seconds or so of missing leaderboard while the room comes
back. Everything else carries on.

## Who is who

There are no accounts, so a player is a name they typed. Two things follow.

A browser makes itself an id and keeps it. That is what a day's rounds add up
against, so a refresh, a reconnect, or a dropped connection does not split one
player into several. The room only accepts an id that looks like one, and falls
back to the connection itself when a client offers none.

Nothing stops two people choosing the same name, and refusing a "taken" name would
be a poor trade for a game you join by typing a word. So names stay as chosen and a
short tag is added only where a list actually shows a clash — most of the time
nobody sees one. Your own row is highlighted either way.

Anyone determined enough could send someone else's id. There is nothing to gain
and nothing to protect until scores mean something, which is where real accounts
come in.

The room does not build a trie. A trie exists to prune prefixes while solving a
whole board, and its 26-way node table needs tens of megabytes; the room only ever
asks whether one word is real, which is a binary search over the sorted list. That
distinction is not academic — the first deploy failed on it, because 128 MB is
plenty on a laptop and not enough in a worker.

### What it costs, and what that bought

On the Workers Paid plan the room's month includes 1,000,000 requests, 400,000
GB-s of duration, 25 billion SQLite rows read and 50 million written, over a $5
base. Nothing here comes close: five hundred players at half an hour a day is
about 130,000 requests and 150,000 row writes a month.

The tightest of them is duration, because a durable object accrues it for every
second it is alive and it is alive while any socket is open. A room that never
goes quiet is 331,776 GB-s a month, or 83% of what is included. One tab left open
overnight is enough to keep it alive, which is worth knowing before adding a
second room.

This was learned the hard way on the free tier, where the equivalent numbers are
per day rather than per month. A day of load testing exhausted five million daily
row reads, because the day's standings were recomputed with a full table scan on
every connection. The room then threw on every join and the error handling closed
the socket, so a leaderboard problem became a total outage with three people
happily playing throughout.

Hence two rules the room now follows. The standings are cached and recomputed only
when a finished round is filed. And **nothing about storage may stop a game**: the
standings, the written-down board, the alarm and the player name all degrade to a
logged error, because a player who cannot see a leaderboard still has a game and a
player who cannot connect does not.

### Not trusting the client

- the server checks each word against its own solve of its own board
- guesses are rate limited to 10 a second, far above typing speed, so pasting a
  solver's output is refused rather than scored
- rejected guesses are counted per player, which is what an accuracy score and
  shadowbanning would be built from

## Running it

    nvm use
    npm install
    ./tools/fetch-sources.sh      # downloads ENABLE + WordNet into data/
    pip install wordfreq
    npm run data                  # compiles them into public/data/

    npm run preview:full          # app + room together, the whole game

`npm run preview:full` builds and serves everything from the worker, which is how
it runs in production. For a fast edit loop instead, run `npm run dev` and
`npm run dev:api` side by side; Vite proxies `/api` to the worker.

Without a room the game still plays solo, so `npm run dev` alone is fine for
anything that is not multiplayer.

`npm test` runs the engine tests, the room's protocol and anti-cheat tests against a
real `wrangler dev`, and Playwright tests that play a round in a browser, put two
browsers in the same game, and simulate a laptop waking mid-break.

The mobile tests run in WebKit, the engine iOS uses, at the viewport sizes a
keyboard leaves behind. There is no keyboard in a headless browser, so the
viewport stands in for one.

`npm run test:boundary` is kept separate because it waits for a genuine round
boundary — up to three and a half minutes — to check that everyone crosses onto the
same new board while words are in flight. That is the one path the rest of the
suite cannot reach. `npm run typecheck` covers tests as
well as app code. `npm run analyze` prints solved boards with their candidate
definitions, which is the fastest way to see the effect of changing the frequency
band.

The compiled data in `public/data` is committed, so the tests run against those
files rather than against whatever `tools/build_data.py` currently produces. If you
change the Python, rerun `npm run data` and commit the result, or the tests will
happily keep passing on stale artifacts.

### Excluding and adding words by hand

The dictionary is a public-domain word list, and it contains words the game
should not offer — a player reported "midget", which was not merely legal but
could be taught in the missed-words column and could be a round's named bonus
word. Two tracked files override the dictionary:

    wordlist/excluded.txt         words the game will not accept
    wordlist/added.txt            words the game will accept anyway

    npm run wordlist              apply them to public/data, then commit

Both take one word per line and allow `#` comments, which are worth adding where
the reason is not obvious from the word and are not worth the overhead otherwise.

Excluding a word excludes every form of it, and removes it from all four
artifacts, so it cannot be played, cannot be taught, and cannot name a round.
Forms are found two ways: through WordNet's inflection map, and by generating the
regular English forms. Both are needed. The map only covers words that have a
definition, and a word whose every sense is a slur has none — so the plurals of
the very worst words were exactly the ones it could not reach. The generated
forms follow the spelling rules rather than just appending letters, so excluding
`spic` does not reach `spices`, and anything generated is dropped only if the
dictionary already had it.

A variant spelling is not a form and will not be found: `gipsy` had to be listed
beside `gypsy`. An added word is playable; give it `word | part of speech | what
it means` and it can also be taught and name a round.

`npm run wordlist` works on the committed artifacts, so a one-word exclusion
needs no corpora, no downloads and no Python packages — just the repo. `npm run
data` ends by applying the lists too, so a full rebuild cannot resurrect an
excluded word. A test asserts every listed word is absent from the shipped data,
which is what catches a rebuild that skipped this step.

Excluding a word has to reach players who already have the old dictionary in
their browser cache. The files in `public/data` are served with a week of
`max-age` and Vite does not content-hash them, so `vite.config.ts` hashes the
data at build time and the client appends it as `?v=`. The bundle that reads the
data *is* hashed and `index.html` revalidates on every load, so a deploy reaches
everyone at once. Without this an excluded word would keep being solved and
taught in returning players' browsers for up to a week, even though the server
refuses to score it.

### Which sense a word is taught

Plenty of words have an offensive sense and an ordinary one. `tools/wordnet.py`
walks a word's senses and teaches the first that WordNet does not mark as a slur,
so a queen is a monarch, a tool is an implement, a shrimp is a crustacean and a
faggot is a bundle of sticks. Senses run most common first, so the first clean one
is also the best one. A word whose every sense is marked gets no definition at
all, which keeps it out of the vocabulary column and out of the running to name a
round while leaving it playable.

A sense is skipped, not fatal, and the same is true of proper nouns. That matters
more than it sounds: "begin", "west", "born", "hunt", "crane" and 478 other
ordinary words had no definition at all, because their first WordNet sense is a
name — Menachem Begin, Mae West — and the old code gave up on the word rather
than trying the next sense.

The marker test reads only the definition, never WordNet's quoted examples. An
example can mention vulgar usage while the definition is clinical, which is how
"fanny" would otherwise have lost a perfectly good gloss. And it matches only
markers that label the *word* a slur, rather than any gloss that mentions such
language: "slur" and "ligature" both keep their musical definitions, and a
disparaging *remark* is not a disparaging *term*.

`npm run review-words` lists the words with a marked sense, and shows what the
game teaches instead, so it is obvious which are already handled. It excludes
nothing. Exclude a word when the word itself is the problem however you define
it — that is a human's call, and it is the only kind left. It is a supplement
rather than a safety net: it would not have caught "midget", whose gloss is the
neutral "a person who is markedly small".

## Deploying

Pushing to `main` deploys, once the two secrets below exist. GitHub Actions
typechecks, runs the whole suite against a real browser and a real worker, and
only then deploys and smoke tests the live site — so a red build never reaches
`goodwords.fun`. Pull requests run the tests but never see the secrets.

Two secrets are needed, both from the Cloudflare account that owns the domain:

    # https://dash.cloudflare.com/profile/api-tokens
    # Create Token -> "Edit Cloudflare Workers" template, and include the
    # goodwords.fun zone so the custom domains can be attached.
    gh secret set CLOUDFLARE_API_TOKEN
    gh secret set CLOUDFLARE_ACCOUNT_ID

Until they exist the deploy step is skipped with a warning rather than failing.

By hand, which is the same path CI takes:

    npx wrangler login
    npm run deploy
    npm run smoke     # checks the deployment actually deals a board

`npm run deploy` publishes the worker, the Durable Object, the static build and
both custom domains together. The domain is registered through Cloudflare, so it is
already a zone in the account and needs no onboarding step.

`npm run live` goes further and puts two real browsers into a game on the deployed
site. `npm run smoke` is worth running every time. Its first check compares the hashed
asset names in `dist/` with the ones the deployment is serving, because committing
is not deploying and the difference is otherwise invisible. The rest covers what
only a real deploy exercises: the websocket reaching the durable object, and the object
reading the word list out of the assets binding. A worker gets 128 MB, far less
than a laptop, and that limit is invisible until you deploy.

The build is about 66 KB of JavaScript plus 1.8 MB of game data that compresses to
roughly 1.2 MB over the wire.

## The rules

5×5, words of four letters and up. Letters must be adjacent, diagonals count, and no cell is reused within a
word.

Scoring departs from Boggle in three ways, all aimed at the same thing: making the
game about words worth knowing rather than words worth memorising.

**Length pays, and keeps paying.** 1/2/4/8/15/25/40 for 4 to 10 letters, 60 beyond.
Big Boggle pays 11 for everything from eight up, so a ten-letter find was worth no
more than an eight. Measured over 400 boards, four-letter words are 47% of
everything findable and eight-letter words 1.8%, so the curve climbs to match.

**Each round is named for a word**, and you are given its definition rather than
the word. It is the longest word the board can spell that is also worth knowing —
99% of boards have one, averaging 7.6 letters. Finding it pays double. This is the
definitions column turned into the objective instead of the reward.

**A word nobody else found is worth double.** That cannot be known while the round
runs, since somebody may still find it, so it settles at the boundary and is shown
in the break. It only applies when there is somebody to have missed it. The board uses the real 25-die Big Boggle set, so the letter mix plays the
way the physical game does — uniform random letters give vowel-starved boards. The
Q die is always played as Qu.

## On a phone

The keyboard does not resize the window on iOS. It shrinks the visual viewport and
the browser then scrolls the focused input into view by its own reckoning, which
put the board off the top of the screen and made the game unplayable.

Two things fix it. The board sizes itself against `--play-space`, the height the
visual viewport actually reports, so it shrinks when the keyboard is up rather than
insisting on a size that cannot fit — with a floor, because letters too small to
read are worse than a short scroll. And once it fits, the game panel is scrolled to
the top of the viewport itself on focus, instead of leaving the browser to choose.

The word box also does not take focus by itself on a touch device: it cannot raise
a keyboard there anyway, and focusing scrolls the page.

## Playing

A first visit explains the rules and asks for a name before the board appears —
it is the one thing you must supply, and it is what the leaderboard shows. **How
to play** in the header brings the same panel back and lets you change it.

Draw a word by dragging across the letters and lift to play it, or tap them one at
a time and press Enter — both follow squares that touch. Going back over the letter
before takes one off, and letters the word cannot reach from where it is are stood
down, so the only moves offered are legal ones. On a phone this means the game needs
no keyboard at all, which is the difference between seeing the board and not.

Dragging on the board always draws a word rather than scrolling the page;
everything below the board scrolls as usual.

Typing still works and mixes freely: the word box does not need to be clicked
first, keystrokes are routed to it from anywhere on the page, and typing a letter
abandons a half-tapped word rather than muddling the two. Enter submits either. **Space turns the board** a
quarter turn, the way you would turn the physical one to see new words; the cells
move but the letters stay upright, and turning never changes which words are
findable. The letters answer as well as the words: an accepted word lights green along the
route you actually traced, a refused one goes red on the same letters, and both let
go quickly — quicker still on a phone, where tapping outruns typing and a highlight
still fading from the last word gets in the way of the next.

During the break, pointing at a missed word traces where it was.

A refresh does not cost you the round: the words found so far are kept and put
back, but only onto the board they were played on. When the game is live they are
also replayed to the room, spaced out so the rate limit does not refuse them, so
the leaderboard catches up too.

Finished rounds are kept — the last sixty — under **Games** in the header, each
with its board, the words you found, the definitions you were shown, and the word
the round was named for, lit on the board where it was. It is all
in `localStorage`; there is still no account and nothing leaves the browser.

## The definitions column

This is the part the spec is actually testing: does seeing what you missed grow
your vocabulary? Picking the words well matters more than anything else here.

Three filters, in order:

1. **One entry per headword, and none you already found.** WordNet defines `snore`,
   and a Boggle list is full of `snores`, `snoring`, `snored`; they collapse to one
   entry. The word you missed is what the entry is titled — you missed `mooches`,
   not `mooch` — with the root named beneath and its definition below that. If you
   found any form of a word, it is dropped: being taught `mooch` while `mooch` sits
   in your own list of finds reads as a mistake, because it is one.
2. **Only real vocabulary.** Words are scored by Zipf frequency and kept between
   1.8 and 4.2. Above that you already know the word (`cat` is 4.8); below it you
   are looking at Scrabble-list residue (`reoil` and `naled` are 0–1.1).
3. **Nothing WordNet flags.** Proper nouns are dropped by checking the capitalised
   surface form in the WordNet data files, which is how `speers` stopped resolving
   to a Nazi architect. Glosses tagged as slurs or vulgar are dropped too.

What survives, ranked by score and then by rarity, is words like `nematode`,
`rictus`, `newel`, `fescue`, `thane`, `plenum`. Measured over 2000 boards
(`npm run floor`), the supply of teachable words per board has a median of 53 and
a minimum of 4; only 0.1% of boards come in under the eight the column shows. So
the filters are strict without ever emptying the column.

The frequency band in `src/game/vocab.ts` is the knob to turn after playing a few
rounds. It is the one number most worth arguing about.

## Layout of the code

    src/game/     the engine, all pure and independently testable
      dice.ts       the Big Boggle die set and deterministic board rolls
      schedule.ts   clock to round number
      trie.ts       flat typed-array trie, for solving a whole board
      wordindex.ts  binary search over the word list, for a single lookup
      solver.ts     full board solve, and pathfinding for one word
      vocab.ts      which missed words are worth teaching
    src/storage.ts  what the browser remembers: profile, past games, the round in play
    src/names.ts    disambiguating two players who chose the same name
    src/net/      the wire format, shared by browser and worker
    src/useRoom.ts  the connection: joins, retries, falls back to solo
    src/components/ the three columns
    worker/       the Cloudflare worker and the GameRoom durable object
    tools/        data pipeline (Python) and the integration tests

## Data

Word list: [ENABLE](https://github.com/dolph/dictionary), public domain — 171,755
words of four letters or more. Deliberately not TWL or Collins/SOWPODS, which are
proprietary.

Definitions: [WordNet 3.1](https://wordnet.princeton.edu/), Princeton University,
used under its permissive licence and credited in the footer.

Frequencies: [wordfreq](https://github.com/rspeer/wordfreq), build-time only.

## What is still missing

No accounts, no history beyond this browser, no sharing, no vocabulary size across
Medium products — all V2 in the spec. Names are self-declared and a player is
whoever is holding the socket, so there is nothing to impersonate yet and nothing
to protect.
