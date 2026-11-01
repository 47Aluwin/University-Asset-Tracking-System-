# User guide

For the three kinds of user: **department staff**, the **Asset Management Team**, and **System Administrators**.
The phone app and the website show the same screens; the phone is meant for fieldwork (scanning, registering,
verifying, reporting damage), the website for administration, review, dashboards and reports. What you see depends on
your role and department — buttons you cannot use are not shown, and the server refuses them anyway.

## Getting started (everyone)

- **Finding your way (website):** the menu bar at the top (Home, Assets, Register asset, Scan, Dashboard, Reports,
  My account — you see only what your role allows) works from every page; the current page is underlined. On the
  phone app, use the home screen tiles and the back button.
- **Filters:** lists, the dashboard and reports group their filters under *Filters*, which shows how many are active;
  *Clear all* resets them. On phones and narrow windows the panel starts folded — tap *Filters* to open it.
- **Dates:** on the website, date fields open a calendar; on the phone, type the date as YYYY-MM-DD (e.g. 2026-03-14).

- **No account yet?** On the sign-in screen choose *Request access*, fill in your department and why you need access.
  An administrator approves or rejects the request; you cannot sign in until then.
- **First sign-in:** an administrator may instead send you a one-time link to set your password (at least 12
  characters, not your email name).
- **Forgot your password?** *Forgot password* on the sign-in screen. After 5 wrong passwords the account locks for a
  while; an administrator can unlock it.
- **Help assistant** (home screen): ask in your own words how to do something in the app ("How do I print a label
  again?"). It explains steps and screens from this guide; it cannot see your asset records or change anything, and it
  can make mistakes. It needs an internet connection and must be switched on by an administrator. Don't type passwords, links or personal
  details into it: on the free AI service, questions may be used by the provider to improve its products.
- **My account** (home screen): change your password, sign out. On a phone, signing out deletes any work not yet
  sent to the server — the app warns you first.

## Department staff

You work with your own department's assets (plus any department an administrator has given you access to).

**Register a new asset** (*Register asset*)
1. Fill in the form. Choose the **Faculty** first, then the **School / department** — only that faculty's schools are
   listed, and changing the faculty clears the school. Type in the search box to find one quickly. Units outside the
   faculties (for example the Library or the Student Support & Facility Centre) are under *Central administration (no faculty)*. Optionally record the
   **assigned staff member** (custodian) and the **asset status** (In use, In storage, Not in use, Awaiting disposal). The asset gets its permanent ID (e.g. `UAT-2026-000123`) when you save — you never type it.
   If the serial number already exists, you are asked to confirm it really is a different item.
2. Print the QR label (*Print label*). In the print dialog choose 100% / actual size, no headers or footers.
3. Stick the label on the asset, then **scan it** (or type the ID under the QR code) to confirm. Only then is the
   asset *Registered*. A reprint always has the same ID and needs a reason.

**Verify an asset** (*Scan asset*): scan its label, choose where you are, *Confirm I can see this asset*. If it is in
a different room than recorded, the difference is flagged; you can also update its location there and then.

**Relocate** (asset page → *Relocate*): choose the new room. Moving to another department needs a reason and
permission in both departments. The old location stays in the history.

**Report missing** (asset page): if you cannot find it. The Asset Management Team confirms or clears it. Scanning a
missing asset later marks it found.

**Condition and damage** (asset page → *Update condition* / *Report damage*): choose the condition, describe the damage,
add up to 5 photos, and optionally open a maintenance request in the same step.

**Maintenance** (*Maintenance*): your department manages its own repair requests — move them through the steps,
record an outside repairer, add costs (each with its currency), and complete them. Completing a repair does **not**
change the asset's condition: confirm the condition separately once it has been checked. If your department requires
approval, someone other than the person who reported the problem approves it.

**Returned for correction** (home screen tile, when there are any): the Asset Management Team has asked you to fix a
record. Open it, read what needs correcting, use *Edit details*, then *Corrections done — send for re-review*.

**Working without a connection (phone app)**: keep working — scans, moves, condition reports with photos, maintenance
requests, edits and new registrations are saved on the phone with the time they happened, and sent automatically
when you are back online. New assets use an ID reserved on your phone in advance, so you can print and attach the
label offline. *Waiting to sync* (home screen) shows what is waiting, what was sent, and anything that needs your
attention (for example a refused item you can fix and send again). Nothing counts as recorded until it is sent.
The website does not work offline.

**Dashboard and Reports** show your department's figures; amounts are always shown per currency. Both can be filtered
by faculty and school, and show totals, condition and value per faculty and per school.

## Asset Management Team

You can see every department's assets, but you oversee rather than do fieldwork.

- **Registration review** (home screen): newly registered records wait here. Open one, then *Approve record*, or
  *Return for correction* with what is wrong (and the fields to check). It goes back to the department; when they
  have corrected it, it appears under *Corrected — re-review* with the old and new values. Review never blocks
  registration, and the asset, its ID and QR code are never replaced.
- **Review flags**: location discrepancies, moves between departments, missing reports, assets found after being
  missing, late records — check and resolve each with a note.
- **Missing assets**: confirm or clear a missing report on the asset page.
- **Maintenance**: view all departments' requests (each department manages its own).
- **Waiting to sync**: see offline edits that clashed with newer changes (the asset's department decides them).
- **Dashboard and Reports**: all departments; export PDF or Excel, or print.

## System Administrators

Everything above, plus (home screen → *Administration*):

- **Access requests**: approve (choose the final role and department) or reject with a reason.
- **Users**: create accounts (a one-time setup link is shown — send it to the person), change role or department,
  deactivate leavers (signs them out everywhere), unlock, issue password-reset links, grant temporary access to
  another department (with a reason and optional end date).
- **Faculties and departments**: add faculties; add schools, research units or central units under a faculty (or under
  *Central administration*); move a school to another faculty (*Change faculty* — its assets follow it in reports); set
  default currencies; turn on *Require maintenance approval* per department.
- **Categories**, **Label layout** (label sheet or label printer size, test print), **Verification schedules**
  (how often assets must be checked, per department and/or category).
- **Audit log**: who did what and when; it cannot be edited.
- Only administrators can archive a registered asset or restore an archived one.

Operational tasks (backups, monitoring, incidents) are in `operations.md` and `backup-recovery.md`.
