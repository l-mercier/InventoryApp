window.InventoryUtil = (() => {
  function itemLabel(item) {
    if (!item) return 'Missing item';
    return item.name || item.type || item.id;
  }

  function segmentLabel(index) {
    return index === null || index === undefined ? 'whole item' : `segment ${index + 1}`;
  }

  function sideLabel(side) {
    return side === 'left' || side === 'right' ? side : 'middle';
  }

  // Projects that aren't a real build with a fixed requirement — items there don't track
  // an "x/needed" goal quantity, in the table or the schematic. Shared here so both stay
  // in sync instead of drifting between app.js and visualizer.js.
  const NO_GOAL_PROJECTS = ['general', 'Prototyping'];
  function hasQuantityGoal(project) {
    return !NO_GOAL_PROJECTS.includes(project);
  }

  return { itemLabel, segmentLabel, sideLabel, NO_GOAL_PROJECTS, hasQuantityGoal };
})();
