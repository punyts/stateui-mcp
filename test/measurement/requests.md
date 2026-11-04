# Measurement requests

The three builds that the search-first measurement repeats before and after each epic (`knowledge-base/design/stateui-search-first-epic-1-search-on-todays-tools.md`, story S1.2, in the AI Minion repository). Each request is the exact prompt given to the agent, then the checklist the result is judged by.

A build **matches the request** when every checklist item is met in the full-page screenshot and the phone-width (390 px) screenshot of the finished app. An item is met only when it is visible and works as described; a placeholder or an empty region does not count.

How to run one build:

1. Start the server with a fresh data folder and a log for this run: `stateui-mcp --data-dir .measurements/<phase>/<request>-<n>/data --tool-log .measurements/<phase>/<request>-<n>/calls.jsonl`.
2. Give the agent the prompt below, word for word, in a new conversation with no other context.
3. When the agent says it is done, take `ui_screenshot` with `fullPage: true`, then again at a 390 px wide viewport, and review the checklist.
4. `node scripts/summarizeToolLog.mjs .measurements/<phase>/<request>-*/calls.jsonl` prints the numbers for the table.

## Store

**Prompt:**

> Build a small online store for a shop that sells houseplants. Shoppers should be able to browse the plants, filter them by category and price, open a plant to see its details, add plants to a cart, change quantities in the cart and go through a checkout that asks for delivery details and shows an order summary. Use some realistic sample plants.

**Checklist:**

1. A product listing shows at least six plants, each with a picture, a name and a price.
2. The listing can be filtered by category.
3. The listing can be filtered or narrowed by price.
4. Opening a plant shows its details: a larger picture, a description, the price and an add-to-cart control.
5. Adding a plant to the cart changes a visible cart count or cart summary.
6. The cart lists each plant with its quantity, and the quantity can be changed.
7. The cart shows a total that follows the quantities.
8. Checkout asks for a name, a delivery address and an email, and checks that they are filled in.
9. Checkout shows an order summary with the items and the total before the order is placed.
10. An empty cart shows a message instead of a blank region.
11. At phone width the navigation and the listing stay usable: nothing is cut off and no horizontal scroll.

## Finance dashboard

**Prompt:**

> Build a personal finance dashboard. Show the current balance, this month's income and spending, how spending splits across categories, how the balance changed over the last twelve months, and a list of recent transactions that can be searched and sorted. Let me add a new transaction and set a monthly budget per category, and warn me when a category goes over its budget. Use realistic sample data.

**Checklist:**

1. Headline figures for the current balance, this month's income and this month's spending, formatted as money.
2. A chart of spending by category.
3. A chart of the balance over twelve months.
4. A table of recent transactions with date, description, category and amount.
5. The transactions can be searched by text.
6. The transactions can be sorted by at least date and amount.
7. A form adds a transaction (date, description, category, amount) and the new transaction appears in the table.
8. A monthly budget can be set per category.
9. A category over its budget is flagged with a visible warning.
10. At phone width the figures and charts stack in one column and stay readable.

## Booking app

**Prompt:**

> Build a booking app for a small guesthouse with four rooms. Guests should be able to pick check-in and check-out dates and the number of guests, see which rooms are free for those dates with their price per night, choose a room, enter their contact details and confirm the booking. The owner should have a separate screen that lists all bookings and can cancel one. Use realistic sample rooms and bookings.

**Checklist:**

1. The guest picks a check-in and a check-out date, and a check-out before the check-in is refused.
2. The guest picks the number of guests.
3. The rooms are shown with a picture, a name, the number of guests they take and the price per night.
4. Rooms that are booked for the chosen dates, or too small for the guests, are marked unavailable or left out.
5. Choosing a room shows the number of nights and the total price.
6. A contact form asks for a name, an email and a phone number, and checks them.
7. Confirming shows a confirmation with the booking's dates, room and total.
8. The flow is shown as steps the guest moves through (dates, room, details, confirm).
9. An owner screen, reached from the navigation, lists every booking with guest, room and dates.
10. The owner can cancel a booking after confirming, and it leaves the list.
11. At phone width the date picking and the room list stay usable.
