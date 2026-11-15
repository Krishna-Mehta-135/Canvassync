export function imageDigestsFromDetails(appDetails) {
  return Object.fromEntries(
    Object.entries(appDetails).map(([service, detail]) => [service, detail.Image]),
  );
}
