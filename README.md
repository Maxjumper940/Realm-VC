# Realm VC

Realm VC is a group voice call for up to 10 people that runs only on your phone.

It does **not** connect to a Minecraft Realm, a Minecraft server, or any game.

## Install (Android only)

1. Download [`Realm-VC.apk`](https://github.com/Maxjumper940/Realm-VC/raw/main/Realm-VC.apk) on an Android phone (Android 8 or newer).
2. Open the APK. If Android asks, allow installs from unknown sources / this file. If Android says the package conflicts with an already installed Realm VC, uninstall the old app first (that clears the saved name and recent rooms), then install this one.
3. Open the Realm VC app and allow the microphone when asked.
4. Tap **Create room** to get a short room code, then share that code with the other people.
5. They open the same app, tap **Join**, and enter the code.

A room holds up to 10 people. During a call you can mute your microphone or leave the room.

## Download

- APK on `main`: https://github.com/Maxjumper940/Realm-VC/raw/main/Realm-VC.apk
- Raw file URL: https://raw.githubusercontent.com/Maxjumper940/Realm-VC/main/Realm-VC.apk

## iPhone (web app)

There's no App Store app yet. iPhone users can use the web version instead:

1. Open https://maxjumper940.github.io/Realm-VC/ in **Safari**.
2. Tap the Share button, then **Add to Home Screen**.
3. Open Realm VC from your Home Screen and allow the microphone.
4. Create a room and share the code, or enter a code to join. Android and iPhone users can be in the same room.

Keep the app open while you're in a call. iPhone may pause the mic if you switch apps or lock the screen.

## Keeping the call on while you play (Android)

Version 1.3.0 keeps the call running when you switch to Minecraft or another game. If Android still closes it on your phone:

1. When Realm VC asks to ignore battery optimisation, tap **Allow**.
2. Or go to Settings > Apps > Realm VC > Battery and choose **Unrestricted** (on some phones it's called "No restrictions" or "Allow background activity").
3. On Xiaomi, Tecno, Infinix, itel, Oppo and Vivo phones, also turn on **Autostart** for Realm VC, and lock it in the recent-apps screen (pull it down or tap the lock icon) so the phone's cleaner doesn't close it.

If the phone does close the call page anyway, Realm VC now rebuilds it and rejoins the same room code automatically.

## Recording calls

Friends' voices play as normal media, so a screen recorder can capture them directly:

1. In the recorder pick **Internal audio** and **Realm VC** (or **All compatible apps**).
2. Join the room. You do not have to turn a recording mode on first.

Realm VC does not open the call as a phone call. Phone-call playback is routed to the earpiece, run through the voice processor (which cuts the high end off speech), and blocked from screen recorders, so the recorder would otherwise listen with the microphone and the voices would sound muffled. Media playback stays full-band on the speaker or headphones, and the app allows other apps to capture it.

The platform echo canceller and automatic gain stay off on that media path, which used to let the phone speaker leak back into the mic and ramp your voice up until it clipped. A send guard subtracts the audio being played, holds the mic at one level with a hard ceiling, and limits peaks, on the speaker and on headphones, including while the call sits behind Minecraft.

Your own voice is not in that video. The recorder will not open the microphone while Realm VC is using it, because Android lets one app record at a time and taking the mic would mute the call. Internal audio only hears what the app plays. Realm VC plays the other people. It does not play your mic out of the speaker, because that is the feedback loop above.
