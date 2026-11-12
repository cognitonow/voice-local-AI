# Roleplay Room

A voice conversation with a 3D character that runs entirely on this computer, in the browser.
No internet needed after the one-time model download.

| Part | Model | Runs on |
| --- | --- | --- |
| Listening | Whisper large-v3-turbo | Graphics card |
| Thinking | Phi-3.5 mini | Graphics card |
| Voice | Kokoro; optionally Chatterbox for scripted lines | Graphics card |

Only models that fit together on an 8 GB graphics card at full speed are offered.

**Recorded lines + Kokoro live:** Chatterbox (expressive but slower than real time) records every
pre-made line once: opener, fillers, interjections, idle lines, cut-off lines and script reactions.
They're saved as .wav files in `characters/<id>/voice/` (e.g. `idle-04-3f9a21c7.wav`), so they travel
with the folder: copy the folder to another PC and the recordings play there with no Chatterbox needed.
Chatterbox shuts down before the thinking model loads, so every thinking model fits. Live replies are
Kokoro. Edit a line and only that line is recorded again. Tuning > Re-record scripted lines deletes a
character's recordings so they're all made fresh at the next Start.

## Characters
Every character is a folder in `characters/`:

    characters/
      mabel/
        character.md      the character: settings and sections (edit in Notepad)
        voice/            recorded lines (made automatically; travel with the folder)
        knowledge/        optional .md/.txt background files the character can look up
        avatar.vrm        optional 3D model for this character
      _template/          copied by "New character" (folders starting with _ are ignored)

On the start screen, pick a character card. **Details** shows what its file contains, what's missing,
its recordings and any warnings. **+ New character** creates a folder from the template; then write it
in Notepad and press **Reload characters**. A single `characters/<id>.md` file still works too.

Each character keeps its own state (mood, puzzle, conversation) while you switch between them, and
Tuning changes to timings and voice apply to that character only (Tuning shows which, and "Reset to
defaults" returns it to its file). Microphone and display settings apply to everyone.
Kokoro voices can be blended: `voice: af_heart*0.6+af_bella*0.4`.

## Mood engine
A character with a `## Mood` section has feelings that persist: pleasure, stress, dominance, trust.
After each reply it adds a hidden `#mood` tag judging what you did (never spoken); the mood moves with
inertia and drifts back to its baseline. `## Mood rules` turn moods into behaviour, e.g.
`- when stress > 0.8 and pleasure < -0.4: Sentences under 8 words.` Mood also sets the face and speeds
up a stressed voice. Stats > Live charts the mood; Stats > Transcript shows what it judged each turn.

## Scripted puzzles
`puzzle: river-crossing` makes the app track the fox, Doris and the grain itself. When you describe a
move ("take Doris across", "row back alone"), it decides whether it's safe, deadly, impossible or the
win, plays the character's line for that event from `## Script` (`### across_duck`, `### deadly_fox_duck`,
... ), and moves the mood by a fixed amount. Anything that isn't a move goes to the thinking model,
which is told where everything is. The banks are shown top-left (Tuning can hide them).

## Speed and listening
- **Warm-up:** after loading, the thinking model writes a 2-word reply in the background so the first real
  reply isn't slowed by the graphics card preparing its code (Log: llm.warm).
- **Speech detection:** Silero, a small neural detector (vendor/silero, 2 MB, runs on the processor),
  tells voices from typing, air-con and background noise. Tuning can switch back to loudness only.
- **Kokoro on the processor:** Tuning > Kokoro runs on. Frees graphics memory; keep it if Live shows
  Voice speed above 1x.

## While talking
- **Stop** or **Esc** cuts the character off.
- **Stats**: Live timings and charts, Transcript, Log, Tuning, and exports (JSON log, CSV per turn).
- Problems show on screen and in Stats > Log with the stage that failed.
