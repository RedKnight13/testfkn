"""End-to-end check of the FKN test build against a local relay."""
import json
import os
import re
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

RELAY = "ws://localhost:7447"
SITE = "http://localhost:8765/"
BASE = SITE + "#relays=" + RELAY
VP = {"width": 390, "height": 844}
T = 15000
TMP = ("test/tmp-network.json", "test/tmp-edition.json", "test/tmp-other.json", "dist/network.json", "dist/editions/latest.json")

for stale in TMP:
    if os.path.exists(stale):
        os.remove(stale)

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

        def node(*args, timeout=20):
            return subprocess.run(["node", *args], check=True, capture_output=True, text=True, timeout=timeout).stdout

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

        def ask(pg, name):
            pg.click("#tab-you")
            pg.fill("#name", name)
            pg.click("#ask")
            pg.wait_for_selector("#code", timeout=T)
            code = pg.inner_text("#code")
            assert re.fullmatch(r"[0-9a-f]{4}-[0-9a-f]{4}", code), code
            return code

        # 1 host starts the network and holds the first seat
        host = page()
        host.goto(BASE)
        host.fill("#hostname", "lamp-17")
        host.click("#create")
        host.wait_for_selector("#link", timeout=T)
        host.wait_for_selector("#myname", timeout=T)
        assert host.inner_text("#myname") == "lamp-17"
        link = host.input_value("#link")
        s = re.search(r"s=([0-9a-f]{64})", link).group(1)
        tag = "fkn" + s[:16]
        print("1 network created, host seated")

        # 2 host opens a room
        host.click("#tab-rooms")
        host.click("#newroom")
        host.fill("#roomtitle", "Water supply")
        host.fill("#roomabout", "Supply, tankers and what the ward office says")
        host.click("#createroom")
        host.wait_for_selector("#compose", timeout=T)
        room = re.search(r"id=([0-9a-f]{64})", host.url).group(1)
        print("2 room opened")

        # 3 a friend asks for a seat; the host approves a code and never sees the name
        friend = page()
        friend.goto(link + "&fast=1")
        friend.wait_for_selector("text=Water supply", timeout=T)
        assert friend.query_selector("#newroom") is None
        code = ask(friend, "River-42")
        host.click("#tab-you")
        host.wait_for_selector(".reqcode", timeout=T)
        assert host.inner_text(".reqcode") == code
        assert "river-42" not in host.inner_text("#host")
        host.click(".approve")
        friend.wait_for_selector("#myname", timeout=T)
        assert friend.inner_text("#myname") == "river-42"
        host.wait_for_selector("text=2 seated", timeout=T)
        print("3 blind seat: host approved code", code, "and the friend took a seat as river-42")

        # 4 what the public can see: nothing in the request or the grant points at the handle
        notes = json.loads(node("test/dump.mjs", tag, RELAY))
        seat = next(n for n in notes if n["kind"] == 4277 and json.loads(n["content"])["name"] == "river-42")
        handle, cert = seat["pubkey"], json.loads(seat["content"])["cert"]
        asks = [n for n in notes if n["kind"] in (4271, 4276)]
        assert len(asks) == 2, len(asks)
        blob = json.dumps(asks)
        assert handle not in blob and cert not in blob and "river-42" not in blob
        print("4 request and grant carry neither the handle, the name, nor the certificate")

        # 5 without the test switch, a granted seat waits for a minute mark before it is claimed
        slow = page()
        slow.goto(link)
        slow.wait_for_selector("text=Water supply", timeout=T)
        slow_code = ask(slow, "paper-boat")
        host.locator(".ask", has_text=slow_code).locator(".approve").click(timeout=T)
        slow.wait_for_selector("#granted", timeout=T)
        granted_at = time.time()
        host.wait_for_selector("text=1 seat granted and not yet taken", timeout=T)
        assert slow.query_selector("#myname") is None
        print("5 granted seat is held back until a minute mark")

        # 6 friend speaks; host sees the unread count, then replies to that message
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
        print("6 message, unread count, reply with quote")

        # 7 a poll: one seat, one vote
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
        time.sleep(1.1)
        friend.locator(".poll button.opt").nth(1).click()   # changing a vote does not add one
        host.wait_for_selector("text=No · 2", timeout=T)
        assert "2 people voted" in host.inner_text(".poll")
        print("7 poll counted one vote per seat")

        # 8 a long post with its own discussion, and following
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
        print("8 post published, discussed, followed")

        # 9 outsiders: a made-up certificate, a member's certificate copied with their name, and unsigned-in notes
        node("test/forge.mjs", tag, room, RELAY, cert, "river-42")
        stranger = page()
        stranger.goto(link)
        stranger.wait_for_selector("text=Water supply", timeout=T)
        time.sleep(1.0)
        assert "FORGED-ROOM" not in stranger.inner_text("#rooms")
        stranger.click("button.room")
        stranger.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        thread = stranger.inner_text("#messages")
        assert "FORGED-MESSAGE" not in thread
        assert "river-42" in thread and "river-42~" not in thread   # the copy did not become a second river-42
        assert stranger.query_selector("#compose") is None
        assert stranger.query_selector("#toseat") is not None
        assert stranger.query_selector(".poll button.opt") is None
        stranger.click("#tab-reading")
        stranger.wait_for_selector("text=Why the tankers came back", timeout=T)
        assert "FORGED-POST" not in stranger.inner_text("#posts")
        print("9 made-up and copied certificates rejected, outsiders' notes ignored")

        # 10 mute and unmute
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
        print("10 mute hides, unmute restores")

        # 11 backup words move an identity to another device, for a member and for the host
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
        host2.wait_for_selector("#myname", timeout=T)
        assert host2.inner_text("#myname") == "lamp-17"
        bad = page()
        bad.goto(link)
        bad.click("#tab-you")
        bad.fill("#restorewords", "one two three four five six seven eight nine ten eleven twelve")
        bad.click("#restore")
        assert "not a valid backup" in bad.inner_text("#view")
        print("11 backup words restore member and host; bad words refused")

        # 12 a copied code: two requests showing one code are never seated; and an asker can start over
        clash_pub = node("test/clash.mjs", tag, RELAY).strip()
        clash_code = clash_pub[:4] + "-" + clash_pub[4:8]
        host.click("#tab-you")
        host.wait_for_selector(".clash", timeout=T)
        rows = host.locator(".ask", has_text=clash_code)
        assert rows.count() == 2
        assert rows.locator(".approve").count() == 0
        redo = page()
        redo.goto(link)
        redo.wait_for_selector("text=Water supply", timeout=T)
        first = ask(redo, "second-try")
        redo.click("#startover")
        redo.wait_for_selector("#name", timeout=T)
        assert ask(redo, "second-try") != first
        print("12 clashing codes cannot be seated; start over issues a fresh code")

        # 13 the edition: a static file a reader can use with every relay unreachable
        with open("test/tmp-network.json", "w") as f:
            json.dump({"s": s, "relays": [RELAY]}, f)
        out = node("scripts/edition.mjs", "test/tmp-network.json", "dist/editions/latest.json", timeout=60)
        assert "Edition written" in out, out
        edition = json.load(open("dist/editions/latest.json"))
        kinds = [e["kind"] for e in edition["events"]]
        assert 4271 not in kinds and 4276 not in kinds          # requests and grants stay out
        assert "FORGED" not in json.dumps(edition)
        seats_in_edition = kinds.count(4277)
        assert seats_in_edition in (2, 3), seats_in_edition      # host, river-42, and paper-boat once claimed
        again = node("scripts/edition.mjs", "test/tmp-network.json", "dist/editions/latest.json", timeout=60)
        assert "unchanged" in again or "Edition written" in again, again
        sockets = []
        reader = page()
        reader.on("websocket", lambda ws: sockets.append(ws.url))
        reader.goto(SITE + "#s=" + s + "&relays=ws://localhost:1")
        reader.wait_for_selector("text=Water supply", timeout=T)
        reader.click("button.room")
        reader.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        assert "river-42" in reader.inner_text("#messages")
        assert "FORGED" not in reader.inner_text("#messages")
        assert "Showing the edition" in reader.inner_text("#status")
        assert all("localhost:1" in u for u in sockets), sockets
        print("13 edition holds seated members' notes only; readable with no relay")

        # 14 the cached edition still opens with the site unreachable too
        reader.reload()
        reader.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        reader.evaluate("navigator.serviceWorker.ready.then(() => true)")
        reader.reload()
        reader.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        time.sleep(0.5)
        reader.context.set_offline(True)
        reader.reload()
        reader.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        reader.context.set_offline(False)
        print("14 app and last edition open with no site and no relay")

        # 15 network.json makes the plain address open the network
        with open("dist/network.json", "w") as f:
            json.dump({"s": s, "relays": [RELAY]}, f)
        plain = page()
        plain.goto(SITE)
        plain.wait_for_selector("text=Water supply", timeout=T)
        assert not re.search(r"[#&]s=", plain.url), plain.url
        plain.click("button.room")
        plain.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        assert "id=" in plain.url and not re.search(r"[#&]s=", plain.url), plain.url
        print("15 plain address opens the network")

        # 16 the held-back seat is claimed on its own, and seats survive a reload
        slow.wait_for_selector("#myname", timeout=110000)
        waited = time.time() - granted_at
        assert waited >= 15, waited
        assert slow.inner_text("#myname") == "paper-boat"
        host.click("#tab-you")
        host.wait_for_selector("text=3 seated", timeout=T)
        assert "not yet taken" not in host.inner_text("#seated")
        friend.reload()
        friend.wait_for_selector("#tab-you", timeout=T)
        friend.click("#tab-you")
        friend.wait_for_selector("#myname", timeout=T)
        print("16 held-back seat claimed after %d s; exactly 3 seats exist; reload keeps a seat" % waited)

        # 17 an edition file saved on one device and opened on another that contacts no relay at all
        for gone in ("dist/network.json", "dist/editions/latest.json"):
            os.remove(gone)
        with host.expect_download() as dl:
            host.click("#saveedition")
        dl.value.save_as("test/tmp-edition.json")
        saved = json.load(open("test/tmp-edition.json"))
        saved_kinds = [e["kind"] for e in saved["events"]]
        assert saved["network"] == s and saved_kinds.count(4277) == 3 and saved_kinds.count(30078) == 1
        assert 4271 not in saved_kinds and 4276 not in saved_kinds and "FORGED" not in json.dumps(saved)
        quiet_sockets = []
        quiet = page()
        quiet.on("websocket", lambda ws: quiet_sockets.append(ws.url))
        quiet.goto(link)
        quiet.wait_for_selector("text=Water supply", timeout=T)
        quiet.click("#tab-you")
        quiet.click("#quiet")
        quiet.wait_for_selector("text=Quiet reading. No edition on this device yet", timeout=T)
        before = len(quiet_sockets)
        with open("test/tmp-other.json", "w") as f:
            json.dump({"v": 1, "network": "f" * 64, "events": []}, f)
        quiet.set_input_files("#openedition", "test/tmp-other.json")
        quiet.wait_for_selector("text=belongs to another network", timeout=T)
        quiet.set_input_files("#openedition", "test/tmp-edition.json")
        quiet.wait_for_selector("text=Edition opened", timeout=T)
        quiet.wait_for_selector("text=Quiet reading. Edition from", timeout=T)
        quiet.click("#tab-rooms")
        quiet.click("button.room")
        quiet.wait_for_selector("text=Only a notice on the gate.", timeout=T)
        assert "river-42" in quiet.inner_text("#messages") and "FORGED" not in quiet.inner_text("#messages")
        assert quiet.query_selector("#compose") is None and quiet.query_selector("#quietnote") is not None
        quiet.click("#tab-reading")
        quiet.wait_for_selector("text=Why the tankers came back", timeout=T)
        time.sleep(2.5)
        assert len(quiet_sockets) == before, quiet_sockets[before:]
        quiet.screenshot(path="test/s3.png", full_page=True)
        quiet.click("#tab-you")
        quiet.click("#quiet")
        quiet.wait_for_selector("text=Connected to 1 of 1 hosts", timeout=T)
        assert len(quiet_sockets) > before
        print("17 edition file saved by a member, opened by hand; quiet reading opened no connection to a relay")

        host.screenshot(path="test/s1.png", full_page=True)
        redo.screenshot(path="test/s2.png", full_page=True)

        assert not errors, errors
        print("ALL PASSED")
        b.close()
finally:
    relay.terminate()
    web.terminate()
    for tmp in TMP:
        if os.path.exists(tmp):
            os.remove(tmp)
