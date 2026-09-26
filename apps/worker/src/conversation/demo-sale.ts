/** Five to eight business days out, skipping Saturday and Sunday. */
export function demoDeliveryWindow(from = new Date()): string {
  return `${formatDay(addBusinessDays(from, 5))} – ${formatDay(addBusinessDays(from, 8))}`;
}

export function demoSaleOutcome(delivery: string): string {
  return `Demo sale. Expected delivery ${delivery}. No real order was placed.`;
}

function addBusinessDays(from: Date, days: number): Date {
  const date = new Date(from);
  date.setHours(12, 0, 0, 0);
  let left = days;
  while (left > 0) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return date;
}

function formatDay(date: Date): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}
