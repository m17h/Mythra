in order:

1. commit changes
2. push to main github repo
3. delete anything in the "dist" folder we don't need
4. build the .app
5. get it signed and notarized (uelf-ashl-wtgp-qmeg)
6. create the .exe (make sure installed has app icon)
7. use create-dmg command on the .app
8. build the release assets
9. create a file in the release assets folder (not inside the new version subfolder) and call it
release_notes.md and in there, delete everything and then put the release notes for the latest
Version like this:

-Added a WPM tracker for an all-time average, current day average, and last dictated message
-Improved UI elements like being able to close windows by clicking off them

Etc

I know I didn't word those well so you do better but basically like that. Those examples were
From another app but you get the idea. This file will change with every release but it helps 
me post the changes to the release repo without having to keep track of every single change we made together. Thanks!