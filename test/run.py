"""End-to-end check of the FKN test build against a local relay."""
import re
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

RELAY = "ws://localhost:7447"
BASE = "http://localhost:8765/#relays=" + RELAY
VP = {"width": 390, "height": 844}
T = 15000

relay = subprocess.Popen(["node", "test/relay.mjs", "7447"], stdout=subprocess.DEVNULL)
web = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", "dist"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        errors = []

        def page():
            ctx = b.new_context(viewport=VP)
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errors.append(str(e)))
            return pg

        def words_of(pg):
            pg.click("#tab-you")
            pg.click("#showwords")
            w = pg.inner_text("#words").strip()
            assert len(w.split()) == 12, w
            pg.click("#showwords")
            return w

        def restore(pg, words):
            pg.click("#tab-you")
            pg.fill("#restorewords", words)
            pg.click("#restore")
            pg.click("#restore")
            pg.wait_for_load_state("load")

        # 1 host starts the network
        host = page()
        host.goto(BASE)
        host.fill("#hostname", "lamp-17")
        host.click("#create")
        host.wait_for_selector("#link", timeout=T)
        assert host.inner_text("#myname") == "lamp-17"
        link = host.input_value("#link")
        s = re.search(r"s=([0-9a-f]{64})", link).group(1)
        tag = "fkn" + s[:16]
        print("1 network created, host seated")

        # 2 host opens a room
        host.click("#tab-rooms")
        host.click("#newroom")
        host.fill("#roomtitle", "Bengaluru water")
        host.fill("#roomabout", "Supply, tankers and what the ward office says")
        host.click("#createroom")
        host.wait_for_selector("#compose", timeout=T)
        room = re.search(r"id=([0-9a-f]{64})", host.url).group(1)
        print("2 room opened")

        # 3 friend reads, asks for a seat, host seats them
        friend = page()
        friend.goto(link)
        friend.wait_for_selector("text=Bengaluru water", timeout=T)
        assert friend.query_selector("#newroom") is None
        friend.click("#tab-you")
        friend.fill("#name", "River-42")
        friend.click("#ask")
        friend.wait_for_selector("#code", timeout=T)
        host.click("#tab-you")
        host.wait_for_selector(".approve", timeout=T)
        host.click(".approve")
        friend.wait_for_selector("#myname", timeout=T)
        assert friend.inner_text("#myname") == "river-42"
        print("3 friend asked, host seated them")

        # 4 friend speaks; host sees the unread count, then replies to that message
        friend.click("#tab-rooms")
        friend.click("button.room")
        friend.wait_for_selector("#compose", timeout=T)
        friend.fill("#compose", "Has anyone seen it in writing?")
        friend.click("#send")
        friend.wait_for_selector("text=Held by 1 of 1 hosts", timeout=T)
        host.click("#tab-rooms")
        host.wait_for_selector("text=1 new", timeout=T)
        host.click("button.room")
        host.wait_for_selector("text=Has anyone seen it in writing?", timeout=T)
        host.click(".msg:not(.own) .reply")
        assert "river-42" in host.inner_text("#replychip")
        host.fill("#compose", "Only a notice on the gate.")
        host.click("#send")
        friend.wait_for_selector(".quote", timeout=T)
        assert "Has anyone seen it" in friend.inner_text(".quote")
        print("4 message, unread count, reply with quote")

        # 5 a poll: one seat, one vote
        host.click("#pollbtn")
        host.fill("#pollq", "Did water reach your street today?")
        host.locator(".pollopt").nth(0).fill("Yes")
        host.locator(".pollopt").nth(1).fill("No")
        host.click("#askpoll")
        friend.wait_for_selector(".poll", timeout=T)
        friend.locator(".poll button.opt").nth(0).click()
        host.wait_for_selector("text=Yes · 1", timeout=T)
        host.locator(".poll button.opt").nth(1).click()
        friend.wait_for_selector("text=2 people voted", timeout=T)
        friend.locator(".poll button.opt").nth(1).click()   # changing a vote does not add one
        host.wait_for_selector("text=No · 2", timeout=T)
        assert "2 people voted" in host.inner_text(".poll")
        print("5 poll counted one vote per seat")

        # 6 a long post with its own discussion, and following
        friend.click("#tab-reading")
        friend.click("#write")
        friend.fill("#posttitle", "Why the tankers came back")
        friend.fill("#postbody", "First paragraph.\n\nSecond paragraph with <b>markup</b> that must stay text.")
        friend.click("#publish")
        friend.wait_for_selector("#posthead", timeout=T)
        host.click("#tab-reading")
        host.click("button.post")
        host.wait_for_selector("#posthead", timeout=T)
        assert host.query_selector("#post b") is None
        host.click("#follow")
        time.sleep(2.1)
        host.fill("#compose", "Good piece. Which ward?")
        host.click("#send")
        friend.wait_for_selector("text=Good piece. Which ward?", timeout=T)
        host.click("#tab-reading")
        host.click("#f-following")
        host.wait_for_selector("text=Why the tankers came back", timeout=T)
        print("6 post published, discussed, followed")

        # 7 an outsider can read but not write; forged notes are ignored everywhere
        subprocess.run(["node", "test/forge.mjs", tag, room, RELAY], check=True, timeout=10)
        stranger = page()
        stranger.goto(link)
        stranger.wait_for_selector("text=Bengaluru water", timeout=T)
        time.sleep(0.6)
        assert "FORGED-ROOM" not in stranger.inner_text("#rooms")
        stranger.click("button.room")
        stranger.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        assert "FORGED-MESSAGE" not in stranger.inner_text("#messages")
        assert stranger.query_selector("#compose") is None
        assert stranger.query_selector("#toseat") is not None
        assert stranger.query_selector(".poll button.opt") is None
        stranger.click("#tab-reading")
        stranger.wait_for_selector("text=Why the tankers came back", timeout=T)
        assert "FORGED-POST" not in stranger.inner_text("#posts")
        print("7 outsider reads only, forged notes ignored")

        # 8 mute and unmute
        host.click("#tab-rooms")
        host.click("button.room")
        host.wait_for_selector("text=Has anyone seen it in writing?", timeout=T)
        host.locator(".msg:not(.own) .mute").first.click()
        host.wait_for_function("!document.querySelector('#messages').innerText.includes('Has anyone seen it')", timeout=T)
        host.click("#tab-you")
        host.locator(".unlist", has_text="Unmute").click()
        host.click("#tab-rooms")
        host.click("button.room")
        host.wait_for_selector("text=Has anyone seen it in writing?", timeout=T)
        print("8 mute hides, unmute restores")

        # 9 backup words move an identity to another device, for a member and for the host
        fw = words_of(friend)
        friend2 = page()
        friend2.goto(link)
        friend2.wait_for_selector("#tab-you", timeout=T)
        restore(friend2, fw)
        friend2.wait_for_selector("#myname", timeout=T)
        assert friend2.inner_text("#myname") == "river-42"
        hw = words_of(host)
        host2 = page()
        host2.goto(link)
        host2.wait_for_selector("#tab-you", timeout=T)
        restore(host2, hw)
        host2.wait_for_selector("#link", timeout=T)
        assert host2.inner_text("#myname") == "lamp-17"
        bad = page()
        bad.goto(link)
        bad.click("#tab-you")
        bad.fill("#restorewords", "one two three four five six seven eight nine ten eleven twelve")
        bad.click("#restore")
        assert "not a valid backup" in bad.inner_text("#view")
        print("9 backup words restore member and host; bad words refused")

        # 10 seats survive a reload, and the app opens with the site unreachable
        friend.reload()
        friend.wait_for_selector("#tab-you", timeout=T)
        friend.click("#tab-you")
        friend.wait_for_selector("#myname", timeout=T)
        host.evaluate("navigator.serviceWorker.ready.then(() => true)")
        host.reload()
        host.wait_for_selector("#tab-rooms", timeout=T)
        time.sleep(0.5)
        host.context.set_offline(True)
        host.reload()
        host.wait_for_selector("#tab-rooms", timeout=T)
        assert "Connecting" in host.inner_text("#status")
        host.context.set_offline(False)
        print("10 reload keeps seats; app opens offline")

        host.reload()
        host.wait_for_selector("#tab-rooms", timeout=T)
        host.click("#tab-rooms")
        host.wait_for_selector("button.room", timeout=T)
        host.screenshot(path="test/s1.png")
        host.click("button.room")
        host.wait_for_selector(".poll", timeout=T)
        host.screenshot(path="test/s2.png", full_page=True)
        friend.click("#tab-reading")
        friend.click("button.post")
        friend.wait_for_selector("#posthead", timeout=T)
        friend.screenshot(path="test/s3.png", full_page=True)
        host.click("#tab-you")
        host.wait_for_selector("#link", timeout=T)
        host.screenshot(path="test/s4.png", full_page=True)

        assert not errors, errors
        print("ALL PASSED")
        b.close()
finally:
    relay.terminate()
    web.terminate()
