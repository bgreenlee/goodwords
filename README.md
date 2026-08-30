# Good Words

A 5×5 word game. Find as many words as you can in three minutes, then spend the
thirty-second break reading the definitions of the good words you missed.

V0 of [Tony's Good Words spec](https://tk.xyz/libraries/d2a9920a-6d24-4603-a6a7-d425db609e1f/notes/271ebdcc-3085-4494-8f65-a7444fe1c425),
single-player: the game, your guesses, and the definitions column.

## Why there is no server

Every client works out the current round from its own clock:

    round = floor(unixTimeMs / 210000)

The board is a pure function of that round number, so everyone who loads the page
in the same 210-second window sees the same board without anything coordinating
them. The dictionary and the definitions are static files. Your history lives in
`localStorage`.

Every clock update re-reads `Date.now()` rather than counting elapsed ticks, so the
countdown cannot drift. That matters because browsers make timers unreliable on
purpose: intervals are throttled to once a second in a hidden tab, once a minute
after a few minutes there, and stop entirely while a laptop sleeps. The clock is
also re-read on `visibilitychange`, `focus` and `pageshow`, so it is correct the
instant the tab is visible again rather than after the next throttled tick.

That makes V0 a static site with no database, which is why it deploys anywhere
that serves files. When the leaderboard arrives, the natural home is a Cloudflare
Durable Object — one per round, holding the scores, with a WebSocket per player.
Nothing about the board generation has to change; `rollBoard` moves server-side so
the board stops being predictable in advance.

## Running it

    nvm use
    npm install
    ./tools/fetch-sources.sh      # downloads ENABLE + WordNet into data/
    pip install wordfreq
    npm run data                  # compiles them into public/data/
    npm run dev

`npm test` runs the engine tests plus Playwright tests that play a real round in a
browser and simulate a laptop waking mid-break. `npm run typecheck` covers tests as
well as app code. `npm run analyze` prints solved boards with their candidate
definitions, which is the fastest way to see the effect of changing the frequency
band.

The compiled data in `public/data` is committed, so the tests run against those
files rather than against whatever `tools/build_data.py` currently produces. If you
change the Python, rerun `npm run data` and commit the result, or the tests will
happily keep passing on stale artifacts.

## Deploying

    npm run deploy    # wrangler pages deploy dist --project-name goodwords

Any static host works. The build is `dist/`, about 65 KB of JavaScript plus 1.8 MB
of game data that compresses to roughly 1.2 MB over the wire.

## The rules

Big Boggle: 5×5, words of four letters and up, 1/2/3/5/11 points for 4/5/6/7/8+
letters. Letters must be adjacent, diagonals count, and no cell is reused within a
word. The board uses the real 25-die Big Boggle set, so the letter mix plays the
way the physical game does — uniform random letters give vowel-starved boards. The
Q die is always played as Qu.

## Playing

Just type — the word box does not need to be clicked first, and keystrokes are
routed to it from anywhere on the page. Enter submits. **Space turns the board** a
quarter turn, the way you would turn the physical one to see new words; the cells
move but the letters stay upright, and turning never changes which words are
findable. During the break, pointing at a missed word traces where it was.

## The definitions column

This is the part the spec is actually testing: does seeing what you missed grow
your vocabulary? Picking the words well matters more than anything else here.

Three filters, in order:

1. **Only lemmas.** WordNet defines `snore`, and a Boggle list is full of `snores`,
   `snoring`, `snored`. Defining an inflection of a word you already know teaches
   nothing, so an inflected board word is credited to the lemma it comes from and
   shown as "on the board as …".
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
      trie.ts       flat typed-array trie over the dictionary
      solver.ts     full board solve, and pathfinding for one word
      vocab.ts      which missed words are worth teaching
    src/components/ the three columns
    tools/        data pipeline (Python) and the browser test

## Data

Word list: [ENABLE](https://github.com/dolph/dictionary), public domain — 171,755
words of four letters or more. Deliberately not TWL or Collins/SOWPODS, which are
proprietary.

Definitions: [WordNet 3.1](https://wordnet.princeton.edu/), Princeton University,
used under its permissive licence and credited in the footer.

Frequencies: [wordfreq](https://github.com/rspeer/wordfreq), build-time only.

## What V0 leaves out

No accounts, no leaderboard, no multiplayer, no sharing — all V2 in the spec. The
guesses column has a marked slot where the live leaderboard goes.
