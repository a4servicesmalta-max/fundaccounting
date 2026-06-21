# Fund Autopilot

**Fund Autopilot reads your fund's documents and does the bookkeeping for you.**

You upload bank statements, share purchase and sale agreements, loan documents, dividend resolutions and invoices. The app reads each one with AI, prepares the accounting entries, and shows them to you to approve. **You stay in control — nothing is final until you approve it.**

---

## The safe idea behind it

This is the important part, so we'll say it plainly:

- **The AI only *reads* your documents.** It works out what each document is about and copies down the figures it can see (amounts, dates, currencies).
- **All the numbers are calculated by the built-in accounting engine** — not by the AI. The engine does the maths: currency conversion, balanced double-entry, gains and losses. It always balances to the cent.
- **You approve every entry.** For each suggested entry you see, side by side, *what the document said* and *what we booked*. Nothing reaches your books until you click **Approve**.

So the AI is your reading assistant; the engine is your calculator; and you are the one who signs off.

---

## What you need

Two things, both free to get started:

1. **A computer with Node.js (version 20 or newer).**
   Node.js is the small free program that runs the app. Download it from <https://nodejs.org/> — choose the **LTS** version and run the installer, clicking "Next" through to the end.

2. **An Anthropic API key.**
   This is the key that lets the app use AI to read your documents. Go to <https://console.anthropic.com/>, create an account (or sign in), and look for **API Keys** to create a new key.
   Copy the key somewhere safe the moment you create it — you'll paste it into the app in the set-up below.

---

## Set-up

Do this once. Each step is copy-paste friendly.

1. **Install Node.js** from <https://nodejs.org/> (the LTS version) if you haven't already.

2. **Open a terminal in this folder.**
   On Windows: open this folder in File Explorer, click in the address bar, type `cmd`, and press Enter.

3. **Install the app.** In the terminal, type:
   ```
   npm install
   ```
   This downloads everything the app needs. It can take a minute the first time.

4. **Add your API key.**
   Make a copy of the file `.env.example` and rename the copy to `.env`. Open `.env` in any text editor and paste your Anthropic API key after `ANTHROPIC_API_KEY=`, so the line looks like:
   ```
   ANTHROPIC_API_KEY=sk-ant-your-real-key-here
   ```
   Save and close the file.

5. **Start the app.** Back in the terminal, type:
   ```
   npm start
   ```

6. **Open it in your browser.** Go to the web address it prints:
   <http://localhost:4350>

When you're done for the day, you can stop the app by closing the terminal (or pressing `Ctrl + C` in it). Start it again any time with `npm start`.

---

## How to use it

1. **Drop in your documents.** On the page, drag your files onto the upload area — or click it to choose them. You can drop a single file, a whole folder, or a `.zip`. It accepts PDFs, scans and photos, spreadsheets, CSVs and text.

2. **Wait while it reads them.** The app reads each document with AI and tells you in plain language what it found — for example: *"Read 12 documents: 7 transactions found, 4 supporting files, 1 needs your attention."*

3. **Review each suggested entry.** Every transaction shows up as a card. On one side you see **"What the document said"** (the figures the AI read), and on the other **"What we booked"** (the balanced accounting entry the engine calculated). You'll also see which company it relates to, the date, an AI-confidence note, and a quote showing where in the document the figure came from.

4. **Approve or Reject.** Click **Approve** to post the entry to your books, or **Reject** if it's wrong. There's an **Approve all** button when you're happy with everything.

5. **See your reports.** Once entries are approved, open the **Portfolio**, **Ledger** and **Trial Balance** tabs. You can **Download CSV** from each to open in Excel or send to your accountant.

---

## What the reports mean

**Portfolio** — *what you own.* A simple list, per company, of what the fund currently holds: its shareholdings and the loans it has made, with their current carrying value. This is your at-a-glance "what's in the fund" view.

**Ledger** — *every approved entry.* The full diary of bookkeeping entries you've approved, in order, each showing the accounts it touched and the amounts. This is the detailed record behind the totals.

**Trial Balance** — *the balance check.* A summary that adds up every account and confirms the books balance — that the total of what's gone in equals the total of what's gone out. If it balances (and it's built to), you know the bookkeeping holds together.

---

## Your data stays on your computer

Everything you approve is stored in a single file on your own machine: `data/autopilot.json`. Your books live there and nowhere else.

The **only** thing that ever leaves your computer is the text of the documents you upload, which is sent to Anthropic's AI so it can be read. Nothing is uploaded or stored anywhere else, and there's no account or cloud to sign in to.

---

## Troubleshooting

**The status pill says "Add your API key" (red).**
The app can't find your key. Open the `.env` file and make sure your real key is pasted after `ANTHROPIC_API_KEY=`, with no extra spaces. Save the file and restart the app (`npm start`).

**"Port already in use" when starting.**
Something else is already using web address 4350. Open `.env`, change the `PORT=4350` line to another number (for example `PORT=4360`), save, and start again — then open the new address (e.g. <http://localhost:4360>).

**I want to start over.**
Use the **Start over** button on the page. It clears all documents, entries and reports so you can begin fresh. (This can't be undone, so use it deliberately.)

---

Made for bookkeepers and fund administrators — no technical background needed. If anything's unclear, the page itself has short tips next to each section.
