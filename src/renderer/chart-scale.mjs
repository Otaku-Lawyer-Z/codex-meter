export function tokenScale(values) {
  const max = Math.max(1, ...values.map(value => Math.max(0, Number(value) || 0)));
  const roughStep = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= roughStep) * magnitude;
  return { max: step * 4, ticks: Array.from({ length: 5 }, (_, i) => step * (4 - i)) };
}
