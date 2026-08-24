# Runtime invariants

Rules that no type, lint, or test enforces on their own, each written down after a
bug or a long review round found it the hard way. [AGENTS.md](../../AGENTS.md)
carries the one-line version of each; this file carries the reasoning, which is
what you need before changing the code they describe.

Read the relevant section before touching: background playback timing, share
ownership, the shared runtime store, room-event broadcasts, or a background
maintenance timer.

中文版见 [invariants.zh-CN.md](./invariants.zh-CN.md)。

## Playback timing invariants

These three cost four review rounds on #210 between them. Nothing in the type
system enforces any of them, so they have to be checked by hand whenever a
background path touches room state or playback timing.

- **Never subtract a local timestamp from a server one.** `serverTime` belongs to
  the server's clock; a local timestamp belongs to this machine's. Their
  difference is the clock disagreement, which is not a duration and drifts on its
  own — a receiver aiming at it wobbles the playback rate forever. Extrapolate
  playback from a local monotonic anchor instead (`clock-controller`), and to send
  an age across machines send a _duration_, never a timestamp. Comparing two
  server timestamps to each other is fine (version ordering); comparing two local
  ones is fine (elapsed).
- **A snapshot age is computed at every send and never stored.** `room:state`
  carries `playbackAgeMs` so a client joining mid-playback knows how stale the
  snapshot it was handed already is (`withPlaybackAge` on the server,
  `resolvePlaybackAnchorAtMs` on the receiver). An age is only true at the instant
  it is sent, so storing one turns it back into a timestamp — which is why it
  lives on the `room:state` payload and not on `PlaybackState`, the shape the
  server persists and clients send back. Every `room:state` send site must stamp
  it (there are four: bootstrap, `sync:request`, and two in
  `room-event-consumer`), and the extension strips it before the state reaches
  storage or a member-delta rewrap.
- **Record a playback snapshot's arrival before the snapshot is observable.** Once
  it is in `roomSessionState.roomState`, a rehydrating content script
  (`content:get-room-state`) can read it and a member join/leave can rewrap it,
  and whichever path compensates first would otherwise anchor it at _its_ moment
  and lose everything the room played before that. `markPlaybackArrival` must run
  before the write and before any `await`. Serializing socket messages would not
  cover this: those readers arrive on the `chrome.runtime` channel, not the socket.
- **After any `await`, confirm the room state you hold is still the current one
  before compensating or delivering it.** Handlers are started per socket message
  with `void handleServerMessage(...)` and do not serialize, so a newer state can
  take over while one awaits (`ensureSharedVideoOpen` may open a tab). A
  superseded snapshot must be dropped, not delivered: the content script's
  staleness check is per actor (`lastAppliedVersionByActor`), so an overtaken
  snapshot from a _different_ member is accepted and moves playback backwards.
  `handleRoomStateMessage`, `applyRoomMemberState` and
  `expireBootstrapRoomStateWait` each carry this check; a new delivery path needs
  its own.

- **A marker that stands for "the user did not cause this" must ask about
  gestures over ITS OWN window, and must not carve out exceptions.**
  `lastUserGestureAt` is the only evidence the content script has that a
  navigation/pause was user-driven, and `userGestureGraceMs` (~1.2s) is the wrong
  span to ask over: any marker whose window is wider has a gap where the user's
  gesture is already forgotten while the marker still reads as fresh. The
  question is "could this gesture be what caused what I am seeing now?", so the
  span must be the marker's window — once it is willing to wait 10s for a
  countdown it owes the same patience to a slow-resolving SPA click.
  **Anchor that span on the marker's instant, not on `now`.** Ageing the gesture
  from `now` while the marker ages from its own timestamp leaves a sliver at the
  tail where the marker is still valid and the gesture has just aged out. The
  marker is valid for events in `[mark, mark + window]`, and a gesture that could
  have caused any of them lies in `[mark - window, now]` — so that is the span,
  and `now` drops out of the test entirely. Its lower bound is load-bearing in
  the other direction: without it, pressing play at the start of a 24-minute
  episode would veto that episode's autoplay forever.
  **Within that span every gesture refutes the marker, with no exception**, even
  though some gestures genuinely are compatible with it — a sharer's drag to the
  last seconds really does end in an autoplay. #236 spent five review rounds
  trying to admit exactly that one gesture, and each fix alternated the failure:
  admit a manual episode click (the sharer pushes a private choice to the whole
  room), then reject a real seek-to-end (the room silently stops advancing). The
  signals cannot separate them — both are discrete input, a click can land
  between `seeking` and `seeked`, and a drag's own release `click` postdates the
  `pointerdown` that began it. The rule is therefore the blunt one, and the cost
  is written down as a test
  ("...the accepted cost of having no gesture exception"): a sharer who drags to
  the end shares the next episode manually, once. Re-introducing the exception
  re-opens the alternation.
  The whole scheme is only safe because `lastUserGestureAt` is refreshed by
  DISCRETE input (`gesture-tracker.ts`:
  pointerdown/mousedown/click/touchstart/keydown/popstate) and never by pointer
  movement or scrolling — a tracker that recorded either would turn passive
  viewing into a veto and silently disable the marker.
  **A one-shot marker must be consumed, not merely bounded.** The evidence that
  refutes it is shorter-lived than the marker itself (`resetUserGestureState`
  zeroes `lastUserGestureAt` on every navigation), so a marker that outlives the
  navigation it explains gets a second chance with its objector gone. Read it
  into locals and clear it at the top of the handler.

- **A window constant that two behaviours share is two constants.**
  `INITIAL_ROOM_STATE_PAUSE_HOLD_MS` was both "how long we suppress a page-load
  autoplay" and "how long a natural-end marker stays valid" (#236). Nothing
  connected the two, so the second was silently pinned to a value chosen for the
  first — and 3s is shorter than Bilibili's ~5s next-video countdown, which made
  the marker expire before every autoplay it existed to catch. When a constant is
  read by a second call site asking a different question, split it and state what
  each value is measured against. Values that a regression test must assert
  against live in `extension/src/content/timing-constants.ts`, not in
  `content/index.ts`: a test that re-types the number passes just as happily
  after someone edits the shipped one.

## Whether the address bar names the video is a per-route property

Two kinds of Bilibili page look alike to the content script and answer this
question oppositely. Getting the polarity wrong is not a degraded answer, it is a
confident wrong one, and #274 is what that costs: after an in-page episode
switch the room's shared video stayed pinned to the previous episode — carrying
the _new_ episode's position, so every other member was yanked back to the old
episode's start — until the sharer reloaded the page.

- `/festival/<id>` keeps its route, and any `?bvid=` it was opened with, while
  the player walks a whole playlist. The address bar there is
  {@link isAddressBarOpaqueVideoUrl}-opaque: the page-bridge snapshot is the only
  identity, and once one resolves, the address bar is _proven_ stale and its
  parse must not be used as a fallback (it would answer "some other, non-shared
  video" and force-pause the page).
- `/bangumi/play/ssNNN` names a season, never an episode, so the snapshot
  outranks it for the same reason.
- `/bangumi/play/epNNN` names the episode itself. Reaching another episode
  changes it — through `pushState` for an in-page switch — and **the address bar
  moves first**, before `__INITIAL_STATE__`, `__playinfo__`, and the episode
  list's highlighted item catch up. Every in-page identity source is therefore
  the one that can be stale here, and the address bar is the one that cannot.

So on an `ep` route the rules invert. Two predicates in `video-identity.ts`
state the comparison, and `page-record-staleness.ts` applies it to every source
the page offers at once:

- **A synchronous media event does not make the video identity synchronous.**
  On an `ss` route, `pause` / `ended` can fire while synchronous
  `getSharedVideo()` still has only the season fallback: reusing a cached
  snapshot requires corroborating page DOM that is not reliable at that instant
  (#291). The natural-end lifecycle therefore uses the synchronous answer only
  when it is stable; an opaque identity gets one fresh
  `getCurrentPlaybackVideo()` read, shared by the adjacent `pause` and `ended`
  callbacks and by any concurrent playback broadcast from that same page visit.
  That read must start before the media-event callback yields: Bilibili can push
  the next episode's `ep` URL in the same task, so starting from a later
  microtask captures the destination visit. A second page-world request must not
  supersede the read that owns the handoff, and the adjacent `ended` must join it
  even when the address bar already names the next episode. Only this event-owned
  read may retain the snapshot returned for its originating unstable visit;
  a newer destination read may not cancel its delivery, and the retained old
  result must never replace that newer visit's shared cache. Ordinary
  current-page reads still discard every result whose visit changed.
  The page-world navigation signal arrives before the snapshot reply, so the
  navigation controller joins an in-flight natural-end resolution before it
  advances its observed-page baseline or resets playback generations. Once the
  resolution settles it retries that same navigation, consumes the resulting
  marker, and only then invalidates the old page context.
  Once confirmed, that event-owned identity is carried through the terminal-
  suppression timer and its final paused broadcast; the timer must not reacquire
  mutable page state or pass the confirmed event through a post-navigation
  mutable-identity gate and let either erase an already-proven debt. The marker
  remains anchored on the media event, not the later bridge reply, as does the
  sharer's suppression arming time. After every await the playback context,
  player session, video element and room/share ownership are rechecked before any
  marker, hold, suppression or broadcast is changed. A later gesture is
  classification evidence for replay/navigation, **not** a new structural lifecycle: dropping
  the terminal result because that evidence changed loses the only paused state,
  while arming at reply time makes the post-end gesture look older than the
  suppression and hides it. **Never extend that async fallback to a stable `ep`
  identity:** page globals may still name the previous episode there, while the
  address bar already gives the authoritative current one.
- **A snapshot naming another episode is "not resolved yet", not "resolved".**
  Snapshot refresh callers still receive `null`, so none can mistake stale page
  globals for the current episode. Explicit sharing does not wait for that
  duplicate confirmation on an `ep` route: `resolveCurrentSharePayload` parses
  the already-authoritative address bar immediately. Its eight-attempt retry is
  reserved for `/festival/` and `/bangumi/play/ssNNN`, where the address bar does
  not name the in-player video and a page snapshot is indispensable (#289).
- **An `ep` route must never be recorded as an address-bar identity refuted.**
  `rememberSnapshotResolved` is guarded by `isAddressBarOpaqueVideoUrl`, which is
  festival-only for exactly this reason. Refuting it would nail the wrong answer
  in place for the rest of the page's life — which is precisely the reported
  symptom of only a reload fixing it.
- **Which sources are stale is one question, answered once for all of them.**
  `markStalePageRecords` takes every record the page offers — the highlighted
  list item, the cached snapshot, the `h1`, the document title — seeds staleness
  on any that names an episode other than the address bar's, and propagates it
  through records that describe the same thing (a shared episode id, cid, or
  title key). Direct confirmation wins over propagation: a record naming exactly
  the address bar's episode is never marked, whatever it links to.

  The single-source version of this rule is what made #274 come back six review
  rounds running. Each round refuted the one source that had been flagged, and
  each refutation cut the link that carried the proof, so the next source
  rebuilt the same wrong answer: the list item was blanked _before_ it could
  match the snapshot, so a snapshot with no episode id of its own never inherited
  staleness through their shared cid; `h1` then repeated the snapshot's title;
  `document.title` repeated it wearing `_番剧_bilibili`. One record with a
  contradiction, three sources rebuilding it. **Chase the whole equivalence class
  in one pass, or the class reassembles itself one source per review round.**

- **Discard a stale source whole, and never filter its output downstream.** A
  source that is marked arrives at `resolveSharedVideoTitle` already empty, which
  is why that resolver is plain "first non-empty" again. Filtering strings
  afterwards is what let `document.title` return `44 连影_番剧_bilibili` after
  `44 连影` had been rejected — the derivation launders the stale name past a
  string comparison. Titles link on `titleRecordKey`, the same reduction the
  resolver applies, so both sides of every comparison have been through it.
- **When every title is stale the label becomes the episode id.** Blank would be
  worse than plain, but the previous episode's name is worse than either, because
  it is the only one that is false.
- **Using an identity takes confirmation; discarding a record takes proof.**
  These are two different bars and the codebase carries two predicates for them,
  `lacksAddressBarEpisodeConfirmation` and `contradictsAddressBarEpisode`. On an
  `ep` route a snapshot must be _confirmed_ to name this episode before it may be
  used — a `bvid:cid` snapshot names no episode at all (the bridge answers one
  whenever the page globals expose no `epId`), and in the switch window those are
  the previous episode's `bvid`/`cid`, indistinguishable from the current one's
  by inspection. Rejecting an unconfirmed identity costs nothing, because the
  address bar already answers completely. Staleness is the other way round: it
  propagates on proof, since a link is evidence about a record and not a licence
  to guess. Both predicates stay inert on routes that name no episode.

The coverage gap that let this ship is worth copying as a warning: every bangumi
case in `share-controller.test.ts` used a `ss` season page, where snapshot-first
is correct, so the rule was applied across the polarity boundary with nothing to
catch it. A regression for one of these routes proves nothing about the other.

## Share ownership is derived, and deltas do not carry it

`sharedVideo.sharedByMemberId` is written once, at `video:share`, and is a
durable reference to a volatile identity — the sharer's seat. #235 is what
happens when it dangles: nobody computes `isLocalSharedSource()`, so nobody
advances the room. Three rules keep it working, none enforced by a type:

- **Resolve at build, never rewrite the room.** `roomStateFromSessions` is the
  single place `sharedVideo` reaches a client, and the only place the stored id
  is reconciled with the live member list (`resolveSharedVideoOwnerId`). A new
  `room:state` build site must go through it. The persisted room keeps the
  original id on purpose: it is the _preferred_ owner, so a sharer whose socket
  merely blipped reclaims the share on reconnect instead of losing it for good.
- **A full `room:state` may only be published where the index is provably
  clean.** A room switch leaves the old room inside `createRoomForSession` /
  `joinRoomForSession`, and `releasePreviousRoom` reports whether `onRoomLeft`
  actually cleared the index. The `room_member_left` delta goes out regardless —
  it reads no state — but the full state is published only where the switcher
  cannot come back — `publishPreviousRoomResync` holds both licences: the join
  was seated (its write re-stamps the whole session record under the NEW room
  code) OR `onRoomLeft` itself landed. A refused join still owes the old room
  its state on the second licence, since the rollback only unwinds the new room.
  "The session hash already names the new room" is not something to assume: that
  hash is written by `onRoomLeft` itself (#242).
- **A membership delta that moves ownership owes a full `room:state`.**
  Protocol >= 2 clients get `room:member-joined` / `room:member-left`, which edit
  the recipient's member list and nothing else — their cached `sharedVideo` still
  names whoever the last full state named. `leaveRoom` publishes an extra
  `room_state_updated` when `needsRoomStateResync`, and the join path does the
  same when the joiner turns out to own the share in the bootstrap state it was
  just sent. Neither check may be replaced by a shortcut that reasons about
  `joinedAt` ordering: that value is stamped by whichever node handled the join,
  so it is a cross-node clock comparison and can reorder members. The tenure
  rule exists to keep ownership from reshuffling on every arrival, nothing more.
- **No `room:state` may be published for a leave until `onRoomLeft` has settled
  _successfully_.** That hook clears the session out of the room index, and
  `getRoomStateByCode` reads the index, not the member map — so a state built
  while the write is still queued, or after it failed, contains the member who
  just left and hands them the share straight back. `runRoomLeftHook` is awaited
  and reports whether it succeeded; the app's implementation awaits
  `runtimeStore.flush`. `room:member-left` is exempt and still goes out on
  failure: it reads no state, so a dirty index cannot corrupt it.
  Two paths beyond an explicit leave need the same treatment, and both are easy
  to miss because the leave is not visible in them:
  - A member switching rooms leaves the old one inside `createRoomForSession` /
    `joinRoomForSession`, which publish nothing of their own — so both handler
    branches release the old room themselves.
  - Those same calls leave the old room _before_ they can fail (room full, bad
    join token, admission lock timeout, code collision). `enterRoom` releases the
    old room on that path too, guarded on `session.roomCode` having actually
    changed, or a failure that never got as far as leaving would broadcast a
    room the member never left.

## The runtime store is write-behind, so "drained" never means "written"

`registerSession`, `markSessionJoinedRoom`, `markSessionLeftRoom` and
`unregisterSession` update this node's own maps synchronously and queue the
shared write behind them. Everything downstream that writes, reads back, and
decides something has to know which of the two questions it is asking (#242):

- **`flush()` says the queue emptied. `confirmWrites()` says the writes landed.**
  `flush` waits on error-swallowed copies, so a failed write drains exactly like
  a successful one. Use `flush` when the point is ordering ("my own writes are
  visible to the read I am about to do") and `confirmWrites` when the point is
  durability. `confirmWrites` is store-wide and clears what it reports, so the
  answer is "since you last asked"; a caller that only needs its OWN write
  confirmed should await that write, since all four report their real outcome.
- **Queued writes are retried with backoff, and a retry can outlive its room.**
  `durable-write-queue` gives every queued write a bounded, backed-off retry
  budget. That reopens the room-code recycling hazard #237 closed: a retry that
  lands after the code changed hands would write into the new room. Only the
  join write ADDS a session to a room, so only it needs the guard — and the pin
  is read when `markSessionJoinedRoom` is CALLED, never inside the retryable
  body: the body does not run until the session's chain drains, which is
  unbounded, so a pin taken there can already name the code's NEXT occupant and
  the check waves the write straight through. A mismatch is a
  `NonRetryableWriteError` (a generation only moves forward, so no later attempt
  can find its way back). An unreadable generation refuses the join rather than
  re-reading later, since a second read is a second chance to pin the wrong
  instance. An ABSENT generation still pins as `""`, which is why the teardown
  leaves a TOMBSTONE in that key rather than deleting it: deleting made "torn
  down" indistinguishable from "never stamped", so a pin of `""` matched the
  room it was about to resurrect. The tombstone does NOT expire — a TTL would
  have to outlive every write that could still be holding the old pin, and
  nothing bounds those, so a lapsed tombstone lets a `""` pin match an absent
  key all over again. What reclaims it is the next occupant's
  `markRoomGeneration`, which is itself conditional on the value that occupant
  pinned — a tombstone is a perfectly good pin THERE, since taking over a
  torn-down code is exactly what a creator does. For the JOIN write it is not:
  pinning the tombstone ITSELF is refused, or a pin taken
  after the teardown would match it. `hasRoomResidue` ignores the key, so a
  tombstone never keeps a code reserved. A new write that seats or moves
  anything by room code needs the same pin; one that only touches keys named
  after the session does not, because session ids are never reused.
- **Every retry budget is sized against the shutdown step that drains it.**
  `close_shared_runtime_store` and `flush_pending_room_event_publishes` carry
  explicit timeouts, and an overrun is logged at error level and reported as a
  degraded step — so a shutdown that merely waited out a retry abandons writes it
  could have landed (it does not exit non-zero; see the DEGRADED rule two bullets
  down). `close()` calls
  `stopRetrying()` first, which cuts the backoffs in flight short AND drops
  writes that have not started, leaving at most ONE in-flight attempt; the step
  budget must exceed that attempt's own timeout. Raising `maxAttempts` or a
  delay means redoing that arithmetic.
- **The retry timing lives in `retry-pacer`, not in each facility.** The
  backoff schedule, the shutdown-cancellable wait, the per-attempt cap that
  does not cancel the call, and the record of calls that outlived one are ONE
  implementation shared by `durable-write-queue`, `pending-resync-queue`,
  `runtime-index-reaper` and the store's command wrapper. They used to be four
  hand-rolled copies, and six of #242's review findings were the same defect in
  whichever copy the previous round had not touched. A new retrying facility
  uses the pacer; it does not grow a fifth copy. What stays local is what
  genuinely differs: ordering/supersession/confirmation, dedupe, and who decides
  to retry.
- **A shutdown step that ran out of its budget is DEGRADED, not failed.** Only
  a step that threw exits the process non-zero (`graceful-shutdown.ts`). The
  budgets exist because these steps wait on I/O this process cannot cancel, so
  giving up on it is the designed outcome. Treating an overrun as a failure
  turned every "what if this particular call hangs?" into a correctness claim —
  a question with no last answer, because each bounded wait added to satisfy it
  becomes a new call site to ask it about. Ten of #242's review findings were
  that one question re-asked. Both outcomes are still logged at error level; a
  drain that gives up must stay visible.
- **A timeout answers the caller; it does not cancel the command.** This one
  bites in three places, and fixing one of them is not fixing it:
  - The session's key is released only once every command the write started has
    really finished (`DurableWriteRequest.settle`). Releasing it when the caller
    is answered lets the compensating write — queued on that same key — run
    first, and the abandoned command then lands on top of its own rollback,
    leaving a member the client was told does not exist and who can win the
    share back. `drain` waits for those releases; `confirm` deliberately does
    not, since a command still in flight has already reported its verdict.
  - Nothing starts a second call while the first has not answered — not the
    write queue, not `pending-resync-queue`, not the reaper's per-room publish.
    Otherwise a hung dependency accumulates one live command per retry.
  - Nothing that closes a connection or a bus does so under a live call:
    `close()` drains the chain (bounded) before `quit`, and the resync drain
    waits out its abandoned calls (bounded) before shutdown closes the bus.
- **A retry is abandoned when a newer write for the same session is queued.**
  Retrying past that point fights the newer write. This is only sound because
  the join write re-writes the WHOLE session record rather than patching
  `roomCode` — so a lost `registerSession` is repaired by the next join instead
  of leaving a hash with no `id`, which `loadSession` reads as no session at
  all. A new session write that carries a strict subset of the record must not
  rely on an earlier one having landed.
- **A join whose index write fails is aborted, not seated.** `runRoomJoinedHook`
  reports failure and the handler rolls the join back through
  `leaveRoom(session, "disconnect")` — `"disconnect"` so a reconnecting member
  keeps the identity the ownership rule depends on. Everything a join sends next
  is read back off the index this write maintains, so a member the room cannot
  see is worse than a refused join the client retries. And if the ROLLBACK
  fails, the socket is dropped: `leaveCurrentRoom` restores the member when its
  own persistence fails and the socket is open, so reporting the join refused
  while the server still holds the seat leaves the two disagreeing.
- **Pruning an orphaned room-index member still owes runtime teardown.** Both
  the periodic reconcile and room listing remove a member whose room body is
  gone so enumeration and counts agree, but removal alone used to consume the
  only code the room reaper could hand to `room-service` (#258). Every prune
  therefore atomically adds a tokened claim to the shared
  `room-index-orphans` hash and its `room-index-orphans-queue` delivery index.
  Quarantining an unreadable body owes the same deferred claim before its index
  member is removed: the bad body blocks delivery while it exists, then repair
  clears the claim or deletion makes it deliverable.
  Shared is essential: the standalone global-admin reconciles the index but
  runs no room reaper. `deleteExpiredRooms` reads that handoff in bounded
  rotating batches using Redis 6.0 commands, without consuming a claim,
  re-checks that no room body took the code meanwhile, and reports the
  survivors as `orphanedIndexCodes` plus their claim tokens. `room-service`
  acknowledges a token only after its existing
  generation-guarded runtime teardown settles. Every script validates both
  handoff key types before any irreversible write, because a Redis Lua runtime
  error does not roll back earlier writes in that script. The point room read
  and sweep both validate the complete persisted-room shape (including nested
  share/playback state) and the expected code: corruption is unknown, not proof
  of code reuse, and cannot consume the claim. A process
  crash therefore leaves the claim for another room node, while a late
  acknowledgement cannot erase a newer claim created after the same room code
  was recycled.

## One-shot broadcasts need a retry trail; repeated ones do not

Nearly every `room_state_updated` is re-sent by the next `video:share` /
`playback:update` / `profile:update`, so dropping one costs a moment. Two are
one-shot, and both lose the room permanently when the bus rejects them (#242):

- The **share-ownership resync** (`publishSharedOwnerResync`) fires precisely
  because the room stopped advancing, so nothing follows it, and an idle room
  never sends `sync:request` either — only a page reload recovers. It goes
  through `pending-resync-queue`, which retries with backoff behind a `request`
  that returns immediately; `firePublishRoomEvent` deliberately does not await
  its wrapper, and making the leave/join handlers block on the bus would be the
  worse trade. A record retries until the bus takes it — a per-record attempt
  budget is just a slower way to discard a notification nothing else will
  re-send — so `drain` is unbounded by design and the shutdown call passes
  `{ final: true }`, which calls `stopRetrying` first and leaves at most one
  in-flight attempt to wait for. A record never starts a second publish while
  its first has not answered: the attempt cap races the bus call, it does not
  abort it, so an unbounded retry loop over a hung bus would otherwise pile up
  one live Redis command per retry — the same "a timeout is not a cancel"
  reasoning as the write queue's `settle`.
- The **runtime index reaper's** announcement is the only thing that tells a
  room a dead node's members are gone. Once the sweep has cleaned the indexes,
  `listClusterSessions` no longer returns those sessions, so a later sweep has
  nothing to rediscover the room from. The reaper keeps its own record set and
  retries it at the START of every sweep — before the "no offline nodes" early
  return — dropping a record only once the publish succeeds. Neither this queue
  nor `pending-resync-queue` caps its backlog: evicting or refusing an
  unpublished record loses exactly what they exist to keep, so a backlog is
  logged, never shed. Because it is uncapped, every SHUTDOWN path over it has to
  be bounded, and there are two: `stop()` drains with bounded concurrency
  against its own deadline, and it sets `stopping` BEFORE awaiting the sweep in
  flight so that sweep's serial drain gives way instead of running the whole
  backlog first. Bounding only the second one leaves the budget just as blown.
  An overrun step is logged loudly AND lets the bus close under
  in-flight publishes, which then delete their records as if they had landed.
  Each publish is capped on its own too: a deadline that only decides whether to
  START the next record bounds nothing when the bus hangs instead of rejecting.
  Sweeps also no longer overlap: they share that set, and `stop()` awaits only
  the sweep it knows about.
  What creates a record is the other half of this: a room is announced only
  once THAT session's cleanup writes are confirmed, and the session record is
  what makes a retry possible at all. The sweep's steps are ordered by what
  they destroy — the member removal needs `roomCode` and `memberId`,
  `markSessionLeftRoom` blanks `roomCode`, `unregisterSession` deletes the
  record — so each runs only after the previous one is confirmed, and a step
  that did not land (failed, capped, or cut short by `stop`) leaves the record
  untouched for the next sweep to redo from the top. Every step is idempotent,
  which is what makes redoing it free. #235 answered this the other way — it
  announced regardless, since `unregisterSession` cleaned the same key anyway
  and gating "left the next pass nothing to retry" — and that reasoning only
  held while the sweep unregistered unconditionally. `unregisterSession` is the
  one write nothing gates on, because it returns `void` (so `confirmWrites` is
  the only place its outcome is visible) and because failing it leaves the room
  index already clean and merely re-runs a no-op next sweep.

## A background pass that cannot time out cannot be observed

`room-reaper`, `room-index-reconciler` and `node-heartbeat` each run one async
pass against Redis per tick. None had a timeout anywhere on that path, and
neither Redis client has one either — `lazyConnect` and `maxRetriesPerRequest:
1` bound retries, not how long a command that Redis already accepted may take to
answer. A half-open connection therefore left a pass pending forever, and the
reaper stopped collecting expired rooms with **no** signal at all: both series
of `bili_syncplay_room_reaper_sweeps_total` went flat, so an alert on the
failure rate never fired, and only a manual restart recovered (#261). The
heartbeat failed the same way and worse: `node_heartbeat_failed` was only ever
reachable through the beat's `.catch`, so a beat that never settled logged
nothing at all, while other nodes aged this one out of the cluster index and
reaped its sessions — from a node still serving clients (#263). All the rules
below live in `maintenance-pass.ts` — one driver, because the same defect turned
up in every hand-written copy:

- **Every tick records exactly one outcome.** That is what makes "the rate went
  flat" mean "the timer is gone" and nothing else. A pass that outlives its cap
  is an `error`, not silence. A cap that only reported the FIRST stalled tick
  would let the series go quiet again while the stall continued, which is the
  original bug with extra steps. But "recorded" is not the same as "failed": a
  tick that finds the previous pass still running INSIDE its cap gets its own
  `skipped` label, because the interval is a configurable positive integer and
  can be set below the cap — filing that under `error` puts the failure rate at
  1 on a dependency that is answering (#262 review). `stalled` therefore always
  follows a `timed_out` on the same call, which is what the runbook tells
  operators to read it as.
- **The cap does not cancel the call, so a pass never runs on top of another.**
  Nothing can abort an in-flight Redis command; the cap only stops the caller
  waiting. Ticking again while the previous command is unanswered piles up one
  command per interval for as long as the stall lasts, and — because the
  shutdown step waits on the promise the LAST tick stored — leaves shutdown
  waiting on the newest pass while older ones are still writing. Same
  reasoning as `pending-resync-queue` and the runtime index reaper's
  per-publish cap. The overlap slot is released by the call's own answer, not
  by the cap: a slot freed one hop late skips the next pass as `still_running`
  and halves the sweep rate.
- **`stop` waits for the real call, bounded — and says when the budget was not
  enough.** The next shutdown step closes the Redis connection, so returning
  while a command is in the air races `redis.quit()`; but an unbounded wait only
  moves the overrun into the shutdown step, which is then recorded as failed.
  `retry-pacer`'s `settleTracked` is that bounded wait, and its budget must stay
  inside the step's own timeout. Giving up quietly is the same trade in reverse:
  that race used to be visible precisely BECAUSE the step timed out, so a `stop`
  that returns cleanly owes an `onSettleTimeout` line naming the calls still
  outstanding. Bounding a wait and dropping its signal in the same change is how
  a fix for silence reintroduces it one step down.

- **The cap is derived from what a late pass costs, not picked for comfort.**
  The reaper's is a flat 30s under a 60s default interval. The heartbeat's is
  computed (`heartbeatTimeoutMs`): half an interval, and never more than a third
  of `NODE_HEARTBEAT_TTL_MS` — because the consequence of a late beat is other
  nodes calling this one stale at `staleAt` and reaping its sessions at
  `expiresAt`. A cap that fired at the same time as the expiry would answer a
  question nobody could still act on. Below the interval is the other half of
  the rule: it is what makes the tick after a timeout a `stalled` rather than an
  `overlapped`.

The cap belongs to the caller, not to the connection. #271 settled the other
half — see [Two layers bound a Redis command](#two-layers-bound-a-redis-command) —
and the split it landed on keeps this rule intact: both the room store and the
runtime store deliberately carry no `commandTimeout`. A backstop several seconds
out answers whoever is still holding the command; it cannot answer a tick that
already gave up, and it cannot tell the next tick whether the previous one is
still outstanding. `heartbeatNode` in particular is a direct `MULTI` — it does
not go through the write queue, so the queue's own
`pendingOperationTimeoutMs` never applied to it. Adding a backstop to either
connection would also settle its request path (`get_room` / `update_room`),
which is a separate decision with its own retry semantics to weigh — deliberately
not taken in #261.

## An unbounded write queue turns a stalled dependency into a growing one

`redis-event-store` serialises appends on a promise chain so the stream's order
matches the events' order. Nothing capped any link of it, and the queue is fed by
**every** structured log line — so the first XADD that never answered turned each
subsequent log line into another closure holding its own event payload, with no
bound and no dedupe. Memory grew with the log rate for as long as Redis stayed
hung, `queryEvents` waited on the same chain and so did every count on the admin
overview, and `close` was `await pendingAppend` and therefore guaranteed to
overrun `close_event_store`'s budget (#264). The rules:

- **A queue that cannot refuse work is not bounded by anything.** The per-write
  cap and the depth limit answer two different failures and neither substitutes
  for the other: the cap fires when Redis stops answering, and the depth limit
  when Redis answers more slowly than events arrive — a state in which no cap
  ever fires and the queue grows forever. Both are needed.
- **Shedding is the right trade here, and is not elsewhere.** The event stream is
  observability data with a `MAXLEN` of its own; losing entries costs an
  incomplete list, which the drop counter then says out loud. That is the
  opposite of `pending-resync-queue`, where a dropped record is gone for good —
  see [one-shot broadcasts](#one-shot-broadcasts-need-a-retry-trail-repeated-ones-do-not).
- **Report the failure as facts, not as an incident.** The first version of this
  logged a start and a matching end, with a magnitude, a stage that could
  escalate, and two possible terminators. #266 then spent four review rounds
  finding states where the pair broke: a node whose traffic went quiet, a
  shutdown that arrived first, a write that answered with an error, a stage
  change that emitted a second start, an end that a raised `LOG_LEVEL` filtered
  away. That was not bad luck. A start/end pair is a span, a span has an
  invariant, and nothing in a log stream can enforce one — least of all in the
  component whose dependency is the thing breaking, so every failure mode of
  that dependency is another way to break it. `maintenance-pass` gets away with
  the same shape only because a timer guarantees each tick is discrete and
  completes; **a pattern's guarantee comes from its precondition, not from its
  shape**, and the append path is a caller-driven stream that inherits neither.
  What replaced it: one throttled line per reason saying what is happening, and
  a counter — which answered "still happening?" and "how much?" from the first
  version onward, statelessly, and was never once flagged.
- **The reporting must not depend on the thing it reports on.** These lines go
  through `logEvent`, which goes through `eventStore.append` — so the report
  competed for the capacity it was reporting about, and produced a reflexive
  loop, a level-routing problem, and per-completed-write churn at the capacity
  edge. Four findings from one bad dependency direction. `logger.ts` excludes
  them from the store and pins them to `error`, together, because both rules
  have that one reason.
- **A dropped append answers its caller successfully.** The caller is the
  structured logger, which turns a rejection into a
  `runtime_event_append_failed` line on stdout. The logger throttles those lines
  by diagnosis to one per minute, covering fast Redis rejections and every event
  store implementation. The throttle tracks at most 32 active diagnoses; any
  extras share one overflow bucket so attacker-controlled error text cannot
  make the throttle's own memory or output unbounded. Shedding still must not
  make every caller handle the same dependency failure. Drops are reported in
  aggregate instead: every drop on the counter, and a shedding line throttled
  to one per reason per minute (#268).
- **The cap does not release the chain.** It flips the store into shedding; the
  link itself still waits for the real answer. Letting the chain advance would
  put a second write on a connection that has answered neither, and would land
  them out of order if Redis recovered — the ordering the chain exists for.
- **A read must not join the write queue it is trying to read about, and past a
  point must not be issued at all.** The chain is serial, so `await
pendingAppend` made a read wait for every queued write to be ISSUED and
  answered one after another — round trips that had not started yet. Bounding
  that wait leaves the read queued behind only the write in flight. But if that
  write is not answering, the read will not come back either, and a longer wait
  is the wrong lever entirely: the admin console polls events and the overview
  every 15s, so each poll leaves another read and its closure in ioredis's queue
  for as long as the stall lasts — timer-driven growth of exactly the kind this
  section exists to stop (#266 review). So the read is refused (`503
event_store_unavailable`), not delayed. The fix for an unbounded queue is
  never a bound on how long you wait for it.
- **"Did the queue drain" is not the question a read has to answer.** The first
  bounded version waited on the chain and then issued the read regardless of the
  answer, refusing only once the append cap had fired — which is 5s away,
  because the cap is long on purpose (tripping it costs records). Every read in
  between went out behind a command that was never coming back, so the defect
  the bound existed to remove survived it (#269 review). A deep queue on a Redis
  that is merely behind does not drain inside the budget either, so refusing on
  that answer would take the console down on a Redis that is working. The
  question is whether the connection is ANSWERING, and only the command at its
  head can answer it — inside the READ's own budget, not the cap's. Two
  behaviours, two constants, again.
- **A read past its own bound is the same evidence a write past its cap is, and
  has to be remembered the same way.** The first version of the bound answered
  the caller and forgot the command. On a node whose appends are quiet — or shed
  — nothing was in flight for the head check to look at, so the next poll sailed
  through it and queued another read behind the first, and the per-poll growth
  this whole section exists to stop reappeared on the read side (#269 review).
  Timing out is not the end of a command; it is the start of knowing the
  connection is bad. A count, not a flag, because reads can be outstanding
  several at a time where the write chain is serial — and it is released when
  the command finally answers, or a single slow moment would take the admin page
  down until the process restarts.
- **That check is evidence about the past, so the read needs a bound of its own
  too.** The read is queued behind whatever is on the connection at the instant
  it is ISSUED, and a stall that begins between the check and the command is
  invisible to any check made before it. Re-verifying the head right there does
  not close the gap and breaks the case the path protects — on a node with a
  queue the head is almost always a write issued milliseconds ago and not yet
  answered, so requiring an answered head would refuse every read on a Redis
  that is merely behind. So the two bounds split the work, and neither
  substitutes for the other: the head check stops a read being issued per poll
  for the whole length of a stall, and the read's own command timeout stops the
  one read already in flight when the stall began from never being answered at
  all — Node's `requestTimeout` bounds RECEIVING a request, not producing its
  response, so it is not the backstop #269 took it for (measured in #277). It
  costs one refused read at the onset of
  a stall — the next poll finds the connection unanswered and is refused before
  anything is issued.
- **`close` drains, bounded, then drops the socket — `QUIT` is not an escape
  hatch.** Dropping the queue outright would lose the shutdown's own events on
  every clean restart, and waiting unbounded makes the step fail on every hung
  one. The event store is the logger's sink, so its shutdown step comes after
  every shared producer; closing it earlier silently loses their teardown
  events. Appends that still arrive after `close` starts are counted as
  `closingAppends` in the abandonment report. A shutdown-step timeout answers
  its caller without cancelling the real producer, so an append that arrives
  after the event-store step returned emits a cumulative update instead of
  disappearing past a one-shot final callback. Then: wait for the chain inside
  a budget, and past it stop the links that have not started, because a command
  issued on a connection that is going away is rejected and the logger turns
  that back into a throttled `runtime_event_append_failed` after shutdown.
  Then `disconnect()`, NOT `quit()`: ioredis puts `QUIT` on the same
  `commandQueue` as everything else and pairs replies front-first, so a graceful
  close inherits the exact wait that was just bounded (#264 review). The graceful
  path is still taken when the chain drained — and is bounded too, because a
  half-open socket swallows `QUIT`'s reply with no write left to blame, and
  that bound owes the same line as every other one here (#266 review): it just
  spent the whole budget, and a `close` that returns cleanly is the only thing
  standing between that and a shutdown recorded as successful. `settleWithin`
  answers "did it settle", which is the right question for the drain (a rejected
  write is still an answer) and the wrong one for `QUIT` (a rejection settles
  just fine while leaving the socket in a state nobody checked) — hence three
  outcomes there, not two. Bounding without reporting is the same trade in
  reverse as in
  [background passes](#a-background-pass-that-cannot-time-out-cannot-be-observed),
  hence `runtime_event_appends_abandoned_at_shutdown`.

One connection, replies in order. That is what makes `disconnect` the only
bounded close, and it is what the read refusal is derived from. It is also the
limit of that refusal: the store can only refuse on evidence from one of ITS OWN
commands, so the FIRST request into a stall — whichever it is — is not refused.
It is bounded and answered as unavailable, and it becomes the evidence that
refuses the next one. That is the best a caller-side bound can do; closing it
entirely needs a separate read connection.

A `commandTimeout` is NOT the other way out, and #271 is where that was settled
for both append-chain stores. It would race the per-write cap, reject the
command from underneath it and clear `writeIsStalled` — the very evidence the
refusal is derived from — turning a chain that freezes and sheds cheaply into
one that grinds a command per timeout while letting every poll back onto a dead
connection. A backstop is a liveness bound; it cannot substitute for a bound
whose output is evidence. A test fixture for this
store is only worth trusting if it models the ordering; one that lets each call
settle on its own will happily prove that reads and shutdown sail past a hung
write.

## Which record may be shed is a property of the record, not of the queue

`redis-audit-store` had the same chain as the event store, link for link, and
the same three consequences (#267). What it could not have was the same answer:
an audit record is the only thing in the system that says who closed a room or
kicked a member, so shedding it quietly is not a trade anybody may make on an
operator's behalf. The rules that fell out:

- **Extract the mechanism, keep the policy at the call site.** The four bounds
  are now `admin/append-chain.ts`, and the two stores differ only in what their
  `onRefused` / `onAbandonedAtShutdown` handlers do — the event store returns
  the record it built, the audit store throws. Writing the chain a second time
  by hand is exactly the shape that cost #242 six duplicate findings, half of
  them "fixed A, missed the isomorphic B".
- **What makes shedding affordable is the feed rate, and it is not a constant of
  the design.** The event store cannot reject, because its caller is the
  structured logger and a rejection becomes one stdout error line per log line.
  The audit chain is fed by admin actions at human rate, so one line per refusal
  is a cost it can pay — and the line is `admin_audit_log_append_failed`, which
  `action-service.writeAudit` already caught long before any of this.
- **Do not add a counter for a question an existing series already answers.**
  The event store needed
  `bili_syncplay_event_store_appends_dropped_total` because its drops were
  otherwise silent. Audit refusals are not: `metricsCollector.recordEvent` runs
  on every `logEvent` regardless of `LOG_LEVEL` or sampling, so
  `bili_syncplay_events_total{event="admin_audit_log_append_failed"}` answers
  "still happening?" and "how much?" with no new surface at all.
- **The admin action still succeeds, and that is why the loss must be loud.**
  The audit write has always been fire-and-forget; taking admin controls offline
  during a Redis outage would be the worse failure. Since the action happens
  either way, the only thing standing between a lost accountability record and
  nobody knowing is the refusal being visible.
- **A shutdown step's budget belongs to the step, not to a component in it.**
  `close_admin_services` closes the admin session store _and_ the audit store,
  and the session store's `await redis.quit()` was unbounded — so bounding only
  the audit store would have left the step failing on exactly the same Redis.
  The two are settled together rather than awaited in sequence, so a rejection
  from one cannot skip the other's close. `quitWithin` is now shared by every
  bounded Redis close; the policy and the budget remain at each call site.

The other four Redis facilities follow the same rule (#270):

- `redis-room-store`, `redis-admin-command-bus` and `redis-room-event-bus` each
  own a default 5s shutdown step. Their `QUIT` budget is 4s, leaving one second
  for shutdown bookkeeping and the degraded report. The two buses close their
  publisher and subscriber concurrently through `quitAllWithin`, whose
  `allSettled` keeps one close error from hiding the other socket's result.
- `redis-runtime-store` owns the 15s exception. Its worst case is 5s for the
  wound-down queue and any deliberately uncapped live caller, 5s more for every
  Redis command that outlived that caller wait, then 4s for `QUIT`: 14s,
  with the same one-second margin. Every command is registered at the runtime
  store's Redis client boundary (including direct reads and `MULTI.exec()`), so
  the close report does not lose one merely because its caller already timed
  out or an upstream shutdown step stopped waiting for it.
- A non-`ok` result drops the socket and emits the facility's
  `*_close_unfinished` event. The bus reports name the client role; the runtime
  store also emits when a caller, a command, or a pacer-held attempt remains
  even if `QUIT` itself answers, and names all three counts plus the caller-drain
  budget. Three, because the drain waits on two predicates that are each blind
  where the other sees: the command set re-checks and so catches commands issued
  DURING the drain, but reads empty in the gaps between one attempt's commands;
  the pacer's set spans those gaps, but snapshots once. Waiting on — or
  reporting — only the first is how a close could say `pendingCommands: 0` and
  stay silent (#272 review).
  Bounding without those lines would only move the old
  `server_shutdown_step_failed` silence one layer down.
- A terminal bus close does not enqueue a second `UNSUBSCRIBE`. The consumer's
  ordinary unsubscribe may already be the command a half-open socket stopped
  answering; `QUIT` also exits subscriber mode, and going straight to its bound
  is what keeps the forced-disconnect fallback reachable. Per-command bounds
  outside shutdown are the connection-wide policy below.

## Two layers bound a Redis command

#261, #263, #264, #267 and #270 were one defect — a Redis that accepts commands
and stops answering leaves some caller waiting with no bound — found by five
different symptoms. Each was closed when its symptom stopped, so the same
deferred question came back five times. #271 answered it, and the answer is a
distinction rather than a number.

- **A deadline** is per-behaviour, derived from what its caller can promise, and
  **decides what happens next**: shed, refuse, retry, abort. `append-chain`'s
  per-write cap, its read bound, `pendingOperationTimeoutMs`, the admin command
  bus's reply timer. Different numbers because different questions.
- **`commandTimeout` is a liveness backstop.** One question — has this
  connection stopped answering? — so one magnitude for every connection that
  takes it (`REDIS_COMMAND_TIMEOUT_MS`, 5s), derived from Redis's latency
  distribution rather than from any caller's patience. It never decides what
  happens next; it only guarantees something does.

A connection needs at least one, and four of the seven had neither. But the two
do NOT compose, and that is the part that decides which connection gets which:

- **A backstop cannot replace a bound whose output is evidence.** Nearly every
  deadline here is built on one mechanism — the cap does not cancel the call, so
  the call stays tracked, and **its continued silence is what stops the next
  attempt**. `ensurePendingCapacity` counting `commandPacer.trackedCount()`
  (#242), `maintenance-pass` reporting `stalled` (#261, #263),
  `pending-resync-queue` waiting on `inFlight` (#242), `append-chain` refusing a
  read on `writeIsStalled` (#266, #269). A backstop settles those calls, so each
  bound reads the connection as idle and lets the next attempt out: it stops
  being a bound and becomes a rate of one more command per timeout window. The
  option would undo all four at once.
- **So the criterion is not "is it already bounded".** A connection may take the
  backstop only if NO caller on it derives a bound from a command's failure to
  answer. Three pass: the admin session store and the admin command bus's two
  clients. Five do not.
- **The declaration is required, and it must NAME the deadline.** Every client
  is built by `createBoundedRedisClient`, whose `RedisCommandBound` is either the
  backstop or a named caller-side deadline. "This one is bounded" was believed
  about the runtime store for as long as nobody had to write down by what —
  while `trackAwaitedOperation` had no bound at all.
  `redis-client-bounds.test.ts` keeps `new Redis` out of every other module,
  because the option's absence is invisible in a diff, which is how it stayed
  invisible five times.
- **Exempt does not mean fine, and the fix is a cap that keeps the call
  tracked.** The room store's request path and the runtime store's had no
  caller-side bound at all, so a stalled Redis hung a WebSocket join with
  nothing counting down anywhere. #277 closed that with `boundCommand` on both
  stores: `capAttempt` answers the caller and leaves the command tracked, so
  `ensurePendingCapacity` and `maintenance-pass` keep reading exactly the
  evidence a connection-wide option would have destroyed. Nothing in the bound
  declarations moved, which is the point — the two layers are still separate.
- **Which bound applies is a property of the CALL, not of the method.** Both
  kinds of caller share these connections and reach the same helpers:
  `loadSession` runs on the join path and inside the runtime index reaper,
  `readRoomBody` inside an admin listing and inside the index reconcile. So the
  bound is passed in (`CommandBound`), and the pass-driven callers pass
  `boundedByOuterCaller` — a claim, written down, that something further out
  stops waiting. Capping those would make `stalled` unreachable and let the next
  tick run a second pass on top of the first, which is #261 and #263 arrived at
  by another route. `redis-store-command-bounds.test.ts` asserts both polarities,
  and hangs the k-th command of every request-path method in turn, because a
  method that bounds its first command and not its third passes any single probe.
- **A bound belongs to each command, never to the operation.** `getRoom` loads
  one session per member and `purgeSessionsByInstance` one per session left
  behind, so a per-method budget fails a healthy Redis for having data — the
  same mistake as giving a startup migration one total budget (#271 review).
- **A request that merely joins a background pass needs its wait bounded, not
  the pass — and bounded on SILENCE, not on duration.** A room listing waits for
  the first index reconcile, whose commands are deliberately uncapped;
  `awaitBootstrapReconcile` bounds the WAIT instead, so the pass keeps running
  and its next caller can still join it. A total budget there would fail every
  admin listing for the length of a HEALTHY migration on a large database, which
  is the same defect as a whole-migration startup budget — so the wait gives up
  only after a full window in which no reconcile command answered at all, which
  is why every pass command declares `boundedByOuterCaller` rather than calling
  the client directly. The absorbed rejection is not optional either: the pass
  outlives the wait, and an unhandled rejection ends the process on Node 22.
- **A cap that can be reached must never be reached by ordinary fan-out.**
  Admission is a refusal-style safety boundary; it is not a scheduler. Every
  read that maps over a collection sized by the deployment — a room listing's
  `REPAIR_CHUNK_SIZE` batch, one `HGETALL` per session or node, an admin service
  asking about every room — runs straight into it and fails on a completely
  healthy Redis (257 rooms was enough). Each of those fan-outs goes through a
  waiting `concurrency-limiter` sized under the admission limit, and the limiter
  sits at the FAN-OUT rather than inside the bound: a limiter in front of every
  command would grow its own unbounded queue of waiters during a stall, which is
  the defect it exists to prevent. `ADMIN_ROOM_FANOUT_LIMIT` is per service, not
  per call, because concurrent calls multiply a per-call batch. The runtime store's
  node and session readers share one limiter for the same reason: two separate
  half-limit pools can jointly consume the whole admission budget.
- **A bound must not be able to leave its function synchronously.** Two callers
  build a `Promise.all([...])` literal out of two bounded commands. A
  synchronous throw from the second abandons the argument list with the first
  command already issued and nobody left to handle it; its cap then rejects into
  an unhandled rejection, which ends the process on Node 22. `boundCommand` is
  `async` in both stores for that reason alone.
- **Node's `requestTimeout` is not a backstop for a slow handler.** It bounds
  RECEIVING a request, not producing its response, so an HTTP handler awaiting a
  stalled Redis is never answered — measured, after #269 and the first round of
  #277 both leaned on it in a comment. Any argument of the form "this path is at
  least bounded by the HTTP server" is false here.
- **Still open, deliberately: one write — the room store's `updateRoom`.** Not
  #237's trade: it is conditional, and that turns out not to be enough. See
  below. Everything else on both connections took a bound.

  `revokeMemberToken` was the last to leave, and it left the way the others
  did — by its GUARD becoming mandatory. Its script only ends the identity
  while the session asking still owns the memberId, so a revocation landing
  after the cap cannot reach the binding a successor is using, which was
  exactly #237's objection. What made the guard mandatory was not an argument
  but an earlier slice of #277: the kick — the one caller that meant "whoever
  holds it now" — had already moved to `evictMemberToken`, leaving the
  session-less path with no production caller at all, like `blockMemberToken`
  before it. **A write can become boundable because a DIFFERENT change removed
  the caller whose needs kept it unbounded**; re-reading the reason on a write
  is worth as much as re-deriving it.

  It also sharpened where a capped write's LOCAL MIRROR update may run. The
  revocation applies its mirror on the CAPPED promise, not on the tracked one:
  the caller acts on the capped answer, and an unconfirmed leave is compensated
  by `restoreLeaveState`, so a mirror update arriving after that restore would
  delete the token `requireMemberToken` checks every later message against —
  leaving the member seated but unable to speak. Redis needs no such care: the
  restore's own write is issued afterwards on the same connection, so it lands
  last and repairs all three keys. The sibling `evictMemberToken` keeps its
  mirror on the tracked promise and is right to: nobody compensates a kick by
  restoring the identity, so its late apply is the intended end state. **The
  question is not "is this write capped" but "does anyone undo it when told it
  failed".** The standalone
  `blockMemberToken` path and the room store's unconditional `saveRoom` write
  had no production callers, so #277 removed them. **A write leaves this list by
  becoming CONDITIONAL, never by re-arguing #237**: a guarded write's late
  landing is a no-op, so the answer its caller was given cannot be wrong.
  `markRoomGeneration` was the third to leave that way, and it took the ordinary
  request-path cap rather than a caller-side deadline, because room creation is
  its only caller and nothing derives a bound from its silence. Its pin belongs
  to the REQUEST: the creator reads the key and passes the value in. Re-reading
  it inside the store would reopen the hole the guard closes — a read answered
  after the caller gave up pins the SUCCESSOR's value, and the guard then waves
  the stale stamp through. A declined stamp is not a failure of Redis, so the
  creator rolls its memberless room back and reports
  `reason=room_generation_superseded` rather than a store error. That rollback
  is what keeps an unstamped room from becoming a permanent orphan — no members
  and no `expiresAt` is precisely what the reaper never collects — so a rollback
  that cannot be written is now logged (`room_rollback_failed`) instead of
  swallowed: capping the stamp made that path reachable by a timeout and by a
  lost code, not only by a Redis error. A version conflict on that rollback is
  NOT evidence there is nothing to collect — it says only that the record moved,
  which is equally true when an admin touched our still-memberless room — so it
  re-reads, compares the join token to see whether the record is still ours, and
  re-CASes within its own bounded attempt count. Only what it truly could not
  expire is reported.

  **Conditionality is what makes a late landing safe to HAVE happened. It does
  not discharge what the write's SUCCESS owes** — and that second half is what
  decides where the cap may sit. Every write that took one has ONE caller owning
  ONE follow-up: the guarded deletes keep the reclamation count, the runtime
  teardown and the `room_deleted` broadcast; `markRoomGeneration`'s creator
  rolls its room back. `updateRoom` has neither property. Its CAS compares the
  whole previous body, so nothing it writes late can corrupt anything — but it
  is reached from six request handlers whose successes owe six different
  follow-ups, and three of those are not self-superseding: a join's seating, an
  admin action's audit record, and the revival of an expiring room. Discarding
  that last one leaves precisely the memberless, never-expiring room the reaper
  cannot collect. A cap inside the store would answer all six by throwing the
  outcome away, which is the same misplacement the guarded deletes were moved
  out of — so `updateRoom` stays, and a bound for it would have to be six
  caller-side effect chains, not one store-side cap. Recorded here because the
  attempt was made and reverted (#277 review): the criterion is not "is this
  write conditional" but "does the cap sit with the owner of what its success
  owes".

  `createRoom` left the list by satisfying the second half, not the first. Its
  `SET NX` guards EXISTENCE, not identity, so a landing that arrives after the
  cap answered is NOT a no-op: it builds a room under a code its caller has
  already given up — no members, no `expiresAt`, the one shape the reaper never
  collects, and no later read reconciles it because nobody holds that code. What
  makes the cap payable is that it has exactly ONE caller, and that caller
  already owns the compensation: `createRoomForSession` expires the room it may
  have created, through the same `expireOrphanedRoom` an unstamped room takes,
  identified by the code and `joinToken` it generated before issuing the write.
  **A version is not an identity**: every new room starts at version 0, so a
  rollback holding version 0 matches a REPLACEMENT that took the freed code
  exactly, and would expire it out from under an owner already told their
  creation succeeded. `updateRoom`'s guard is therefore a
  `RoomUpdateGuard`: a version, or the room INSTANCE (`{ joinToken }`), compared
  in the same read that produces its CAS guard — a check-then-act would leave
  the window open again. A SHAPE rather than a nullable version, so "skip the
  version check" cannot be asked for without saying which room is meant; that
  combination would write to whatever holds the code. The recycling regression
  used to bump the replacement to version 1 before asserting, which is why the
  hole survived #237 and #301.
  It also stops trying other codes — a store that is not answering will not
  answer the next one, and each further attempt would leave another orphan. Only
  a `timeout` is compensated: an `admission` refusal is the one answer on this
  connection that proves no command was issued, so rolling back there would
  write over a room that does not exist and report a residue that never was.

  **The compensation is itself a second lifetime, and missing that is what would
  have made the cap worthless.** Its write half is `updateRoom`'s CAS, which the
  store leaves uncapped — so a creator that simply awaited the rollback would
  hang on the compensation instead of on the create, and `createRoom`'s cap
  would bound nothing. The request bounds its WAIT on its own constant
  (`DEFAULT_ROOM_ROLLBACK_CONFIRM_TIMEOUT_MS`, not the Redis liveness backstop
  and not the delete's), the effect keeps going, and `closeRoomService` drains
  it inside the same shutdown budget as the delete chain and the runtime
  teardowns, reporting `pendingRoomRollbacks`.

  Splitting the wait is only half of it: **an effect that keeps going must not
  be built out of capped calls.** The rollback's own read took the store's
  request cap, which ENDS the call at the first timeout — the CAS was then
  never issued, and a create that landed late stayed behind exactly as before.
  So `updateRoom` takes a `boundedBy` declaration, a NAMED caller-side deadline
  rather than a boolean, and that call runs admitted but uncapped like the
  guarded deletes. Which bound applies is a property of the CALL, as everywhere
  else here. `close()` gates it too: an effect admitted after the shutdown
  snapshot is one nobody waits for and nobody reports, so a rollback that would
  start while `closing` is refused and logged instead — the same rule the lazy
  delete follows one function over.

  Pinning the rollback by INSTANCE rather than by version is what collapsed the
  rest of it. the rollback passes `{ joinToken }` instead of a version — the
  same reason `deleteRoom` pins that way: an admin
  touching the still-memberless room moves its version, and a version-exact
  guard would decline the very change that makes the rollback matter. With the
  store answering `not_found` for a code that changed hands, the loop's re-read,
  its identity re-check and its false-alarm reasoning all disappear; what is
  left is a bounded number of attempts against a live byte-CAS conflict.

  The rollback can still be REFUSED before it issues, when the create that owes
  it took the last admission slot and still holds it; that is reported as
  residue and given no reserved capacity, because admission's value is being one
  number bounding ioredis's queue and a second class inside it would not shrink
  the queue that caused the refusal.

  The room store's delete left the same list the same way, in TWO guarded forms
  because the guard is a property of the CALL, not of the method. `deleteRoom`
  pins the instance by `joinToken`: an admin closing a room disconnects its
  members first and their leaves rewrite the record, so a version-exact guard
  would decline the very action that caused the change. `deleteExpiredRoom`
  requires the record to still be expired, judged inside the guarded write —
  an expiry can land on a room other nodes are still using, and no arrangement
  of check-then-act closes that. Each is ONE command that decodes the body and
  compares ONE field. Not the whole bytes, the way `UPDATE_ROOM_CAS_LUA` does:
  an update must not be built on a stale body, while a delete must not take a
  DIFFERENT ROOM, and comparing bytes conflates the two — the leaves of the
  members an admin close just disconnected rewrite the record, so a byte-exact
  guard declines the action that caused the change and then skips the runtime
  teardown and the `room_deleted` broadcast while reporting success. Nor read
  then write under the bytes read, which has the same defect plus a split
  between the judgement and the write. Decoding is allowed here for the reason
  the sweep may do it: nothing is written BACK, and the rule this file lives by
  is that room JSON is never RE-ENCODED in Lua.
  The OUTCOME then matters as much as the guard, because runtime teardown and
  the `room_deleted` broadcast are addressed BY CODE: a caller that runs either
  after a `superseded` delete acts on whoever holds the code now. `resolveRoom`
  answers from a fresh read instead, and `closeRoom` / `expireRoom` skip both
  steps and log `admin_room_close_superseded` / `admin_room_expire_superseded`.

  **Which is why neither delete may be capped inside the store.** A successful
  delete owes more than its own answer — a reclamation count, the runtime
  teardown, the one-shot `room_deleted` — and every one of those lives in the
  CALLER. A cap in the store answers by DISCARDING the command's outcome, so all
  of them silently stop happening, and each caller then grows a private
  compensation for each one: a teardown debt here, a re-read-and-announce there.
  Three review comments on #302 were three symptoms of that single placement.
  The rule is the one #282 and #284 already settled one layer down: **the cap
  answers the caller, the effect keeps the outcome its follow-ups need.** So the
  store declares `boundedByOuterCaller`, each caller builds delete-plus-
  follow-ups as ONE chain and caps only its own WAIT, and a delete that lands
  late still counts, still tears down, still broadcasts. `resolveRoom` preserves
  a third outcome: on the deadline it fails rather than answering `null`,
  because the late guard may still answer `superseded` and only a confirmed
  absent room may be reported absent. **That third outcome stays off the wire.**
  It reaches clients as `internal_error` — the answer every other bounded store
  command already gives when it cannot answer, and the only existing code that
  says "no answer" without asserting one. Minting a code for it would buy a
  protocol version, a compatibility gate for every older client and a
  client-side retry state machine, in exchange for a window the next attempt
  resolves by itself; the diagnosis belongs in the log's `trigger` and
  `confirmation` details instead. It must never become `room_not_found`: the
  released controller treats that as terminal for a pending join AND for a
  stored room context, so an outcome that cannot prove the room absent would
  clear the user's session on its way past. Concurrent readers share the one
  in-flight collection effect for the room code: the effect enters the shutdown
  tracker once, and request deadlines cap only their own waits—never another
  tracked wrapper or another underlying Redis delete.
  Preserving the outcome still requires Redis queue admission. Request reads and
  both guarded deletes enter one shared `maxPendingCommands` counter before
  they issue, and every accepted command holds its slot until the real reply.
  A delete refused there was never sent, so it has no late outcome to preserve.
  A join error captures that generation and its exact target before persisting
  any credential change, then revalidates both after the await; an old
  `member_token_invalid` response can therefore neither clear nor schedule a
  retry over a replacement socket or a newer popup join.
  `closeRoom` / `expireRoom` refuse to report a completed action they cannot
  confirm and return 503 `room_delete_unconfirmed`, while the effect logs its
  own late outcome. That ownership extends through shutdown: the admin action
  service first closes deletion admission, then drains accepted action handlers
  before the delete-plus-follow-ups chains they may create. The room service
  likewise closes lazy-delete admission, then drains lazy deletions before any
  runtime teardown they create, all while the room store, runtime store and
  event bus remain open. Each owner has one explicit budget and reports what
  remains instead of letting a later dependency close silently cut the effect
  off. Runtime teardown is reported from its retry-debt ledger rather than its
  request-confirmation tracker: a fast rejection or guarded skip can settle the
  latter while leaving an ownerless debt as the only process-local trail to an
  already deleted room. `redis-store-command-bounds.test.ts` holds the mechanical
  half: with a command hung, both deletes must be left UNANSWERED, while either
  a read or a delete occupying the last admission slot makes the other refuse
  without reaching Redis. No classification table can see a cap that quietly
  reappears inside the store. Atomic
  `evictMemberToken` is different: the admin executor caps only its own wait and
  reports `status=error, confirmation=unconfirmed, code=block_unconfirmed`,
  while the original promise keeps the Redis write and both local-mirror
  updates alive, then
  disconnects the socket so normal leave cleanup still runs. Terminal
  `admin_command_executed` reporting belongs to that real promise, not to the
  bounded waiter, so late success and late failure both remain observable. The
  command bus uses the same additive confirmation marker after an admitted
  publish can no longer prove whether the target executed it; the established
  failure status stays `error`, so an older parser can still consume the result
  during a rolling upgrade. A Redis `PUBLISH` result of zero is instead a
  confirmed `stale_target`. The admin action layer therefore audits the typed
  confirmation rather than maintaining a list of codes, at the last layer that
  still knows the actor. Result transport retries the exact executor result:
  failure to publish an answer is not evidence that execution failed and must
  never erase its confirmation state. Retrying is safe across nodes because the
  eviction script keeps the maximum block deadline: two attempts commute even
  when the older one lands last. That ownership extends through shutdown: the
  consumer closes its dispatch gate before unsubscribe can wait, then gives the
  subscription, every accepted handler, and every eviction that outlived its
  handler one shared close budget. Exhausting it records
  `admin_command_consumer_close_unfinished` with separate pending counts rather
  than relying on a later runtime-store close to drain an effect the consumer
  owns. The gate matters because the Redis bus may already have captured a
  handler behind a promise boundary; such a handler answers `stale_target`
  instead of creating fresh work after the drain snapshot. Runtime room
  teardown is bounded without cutting that effect trail: its generation
  argument is mandatory and the Redis script has no wildcard mode;
  `room-service` keeps one real teardown promise per room generation through the
  Redis write and every local mirror, so an old unanswered effect cannot hide
  cleanup for a later occupant of the same code. Every request waiting on that
  exact effect shares one confirmation promise and one behaviour-deadline
  constant; it is deliberately not Redis's connection-liveness constant. A
  request records an unconfirmed outcome, while a reaper passes
  `maintenance_pass` to both precondition reads and awaits the real promise so
  `stalled` remains reachable. Retry debt is assigned when the latest exact
  effect is created (or has no owner while awaiting a fresh attempt); a waiter
  reusing an effect never transfers ownership, because its generation may have
  crossed the room-read await. The generation pinned before that read is
  confirmed again afterwards before an effect may be created or reused. Every
  pending debt is a unique record; a maintenance candidate snapshots that
  identity and re-checks it after the preconditions, so an owner success during
  those awaits cannot be followed by a new effect for the settled debt. A newer
  generation's success or a live persisted room supersedes older effects, so
  their late skip or failure cannot retain or resurrect the debt. An owning late
  success clears the debt, an owning late failure leaves it queued, and each
  effect owns a terminal log. The remaining five differ from
  `acquireRoomLock` and `tryClaimMessageSlot`, which ARE capped at the store:
  a `SET NX PX` that lands after its caller gave up releases itself at its TTL,
  so "may have landed" costs one lock interval rather than a permanent wrong
  answer.

- **An expiring claim still has an owner.** Claiming writes the token, slot TTL,
  and teardown-index score in one Lua operation, so an old tracking write cannot
  arrive after a newer owner and overwrite its score. Early cleanup uses a
  second Lua operation to check that token before deleting both the slot and its
  teardown index. A capped release may land after the old TTL and after another
  node has claimed the same logical key; an unconditional `DEL`/`ZREM` would
  erase the new generation. Cleanup is also
  subordinate to the business outcome already chosen: its timeout is logged and
  absorbed rather than replacing a validation, persistence, or version error.
  The score and its residue-prune cutoff both use Redis `TIME`, matching the
  clock that advances the slot TTL; blocked-token scores remain on the
  application clock and are pruned separately.
- **An exemption covers commands, not the handshake.** `connect()` runs before
  the store exists and resolves on `ready`; ioredis's `connectTimeout` bounds
  the TCP connect and not the `INFO` after it. Without either bound, bootstrap
  waits forever on a host that accepts the socket and answers nothing, so an
  exempt connection opens through `connectWithin`.
- **A completed handshake does not cover the next startup command.** The room
  event consumer awaits its first `SUBSCRIBE` before the server can listen, so
  that command runs through `startWithin` on the dedicated subscriber
  connection. If Redis stops replying in the gap after `ready`, startup fails
  with a staged error and disconnects that subscriber; it does not add a
  backstop to the publisher whose silence is retry evidence. The message
  handler is installed before the command is submitted, because ioredis may
  dispatch a message following the SUBSCRIBE ACK in the same socket read.
  SUBSCRIBE and final UNSUBSCRIBE share one serialized reconcile: a handler
  arriving during the latter waits for its ACK and a new SUBSCRIBE ACK before
  registration succeeds, rather than inheriting a channel that is about to be
  removed. Registering the same handler twice is refused instead of orphaning
  the first listener behind a map replacement.
- **It bounds the caller's wait, not the connection's queue.** ioredis keeps a
  timed-out command in `commandQueue` so later replies stay aligned. Every
  caller-side depth limit here — `maxPendingAppends`, the runtime store's command
  admission — remains essential and none may be retired on the strength of the
  option. The three backstopped connections synchronously cap commands before
  submission; the command bus separately caps active reply subscriptions and
  their request closures. That cap is a refusal-style safety boundary, not a
  scheduler. All concurrent room-close calls in one admin service therefore
  share a waiting fan-out limiter sized to half the reply capacity; single
  `kickMember` / `disconnectSession` actions bypass it and retain the other half.
  A per-call batch cannot make that promise because concurrent calls multiply
  its budget. A timed-out promise can free one admission slot while its command
  remains queued, but the stalled guard resets after at most its
  threshold, so the real queue is bounded by admission plus `threshold - 1`.
  They also disable `autoResendUnfulfilledCommands` and `autoResubscribe`.
  Ordinary command attempts are pinned to their submission generation: reset
  refuses new attempts until `ready`, and late failures from the retired socket
  cannot drop its healthy replacement. Every failed
  subscription-state change marks that command-bus subscriber generation for
  reset, because a failed `SUBSCRIBE` may still land and a failed `UNSUBSCRIBE`
  may leave its unique channel behind. A refused `SUBSCRIBE` happens before
  submission and does not reset a healthy subscriber; a refused durable restore
  keeps its barrier and retries through `retry-pacer`. A cleanup `UNSUBSCRIBE`
  is different: its channel already left desired state, so even an admission
  refusal retains a reset trail. New commands are refused immediately;
  the reset happens at once when no result is active, or after the already-active
  replies finish so cleanup cannot sever another command's reply trail. Failures
  submitted by an older generation cannot reset its replacement. ioredis then
  moves `commandQueue` to `prevCommandQueue` and discards it instead of replaying
  it after reconnect.
  The admin command bus restores the durable command channels from its handler
  registry and result channels for requests that are still awaiting an answer;
  a completed request is removed from desired state before its fallible cleanup,
  so that channel is not resurrected. A restore in progress gates new publishes,
  and a failed restore carries its exponential `retry-pacer` backoff across
  `ready` generations — ioredis resets its own retry counter at every `ready`,
  so its reconnect policy alone would be a fixed-rate loop. The timeout alone
  still provides no queue bound. Proved, not assumed, in
  `redis-client-bounds.test.ts`, `redis-admin-session-store.test.ts`, and
  `redis-admin-command-bus.test.ts`.
  The caller-bounded room-event publisher has the complementary shape: its
  submission admission retains a slot until the real Redis `PUBLISH` settles.
  A `firePublishRoomEvent` wrapper timing out therefore cannot reopen that slot;
  ordinary events, one-shot resyncs, reaper announcements and admin publishes
  all meet the same bus-wide real-command cap. This is covered by
  `redis-room-event-bus.test.ts`.
- **A threshold that cannot tell slow from dead is the failure to avoid.** It
  sits far above ordinary latency, because tripping it on a Redis that is merely
  behind converts a degraded dependency into a failed one on every connection at
  once.
- **Bounded still owes a report.** A connection whose commands now fail owes the
  caller a diagnosis, not just an error: a stalled session store answers 503
  `admin_session_store_unavailable` — never 401, which would read as a logout —
  while room/runtime timeout and admission failures answer 503
  `room_store_unavailable` / `runtime_store_unavailable`, not the catch-all 500.
  That translation is one shared HTTP-boundary policy: both the admin router
  and the dedicated metrics server use it, so moving `/metrics` to its own port
  cannot turn the same dependency outage back into an undiagnosed 500.
  The session path logs `admin_session_store_command_failed` with the Redis
  detail the response withholds from an unauthenticated caller. Requests refused
  while the guard waits for `ready` go through the same reporting path. An
  executor result refused by publisher admission never became a Redis
  operation, so it must not inflate the Redis-failure counter; the terminal
  result-publish callback instead increments
  `bili_syncplay_admin_command_result_publish_failures_total`
  unconditionally, before its diagnostic log is throttled. This says the
  executor could not complete the publish path, not that delivery was certainly lost: a
  timed-out Redis `PUBLISH` remains queued and Pub/Sub provides no requester
  receipt.
- **Cleanup on the same connection is not the answer.** Where a request brackets
  its real work with commands on the stalled connection, those rejections must
  not replace the result: the admin command bus's `finally` `UNSUBSCRIBE` would
  otherwise throw over the `command_timeout` result the stall exists to produce.
  It still cannot be forgotten: a failed cleanup marks the subscriber for reset,
  protects replies already in flight, then restores the durable registry. A
  message-slot rollback follows the same ordering rule: report the cleanup
  failure, but preserve the business error that triggered it.

## Test fixtures must not cast past the checker

Every package's `test/**` is inside `npm run typecheck` — otherwise a signature
change that misses a test call site passes the gate silently, and can hide the
behaviour regression the missed argument causes (`#210` / `#211`). How a package
satisfies it depends on whether src and tests can share one compiler
configuration:

- `protocol`, `server`, `extension` need a second project, because their tests
  need `node` types (and `server`'s reach into `bench/`) that the src build must
  not carry. Their `typecheck` runs `tsconfig.json` then `tsconfig.test.json`.
- `admin-ui` needs no second project: its `tsconfig.json` already includes
  `test` (its src is browser code compiled by Vite, so no split is required).

A new package picks whichever applies — do not add an unnecessary
`tsconfig.test.json` just to match the majority.

Keep fixtures honest rather than casting past the checker: a fixture that no
longer matches its type usually means the type moved (a field was renamed,
removed, or became required), and the fix belongs in the fixture. Three casts to
avoid specifically, because each re-opens the gap this gate exists to close:

- `as unknown as <DomainType>` / `as never` on a fixture (`RoomState`,
  `PlaybackState`, `Session`, `RoomStore`) — it silences exactly the
  missing-required-field error you want to see.
- A stub satisfying an unconstrained `<T>(…) => Promise<T>` via `as T`. No value
  inhabits every `T`, so the cast is unconditional.
- A stub satisfying a contract that lumps several request/response pairs into
  one all-optional response type. `{}` then satisfies everything and nothing is
  checked — `#211` shipped this mistake once before catching it.

When a callback serves one request/response pair, declare that pair. When it
serves several, split it into one callback per pair (`sendPlaybackUpdate` /
`requestRoomStateHydration`) rather than widening the response. When the payload
genuinely cannot be modelled and must be runtime-guarded anyway, declare
`Promise<unknown>` and let the guard narrow it. If a consumer only touches part
of a large interface, its parameter should say so (`Pick<RoomStore,
"countRooms">`) — that removes the fake's need to cast at all.

`as unknown as T` is fine for genuinely unfakeable platform/library objects
(`ws.WebSocket`, `chrome.tabs.Tab`, `HTMLVideoElement`, `IncomingMessage`);
prefer one shared constructor over per-call-site casts.
