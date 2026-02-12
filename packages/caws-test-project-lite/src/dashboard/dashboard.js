/**
 * Dashboard module for the lite test project
 */

function getDashboardData(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  return {
    widgets: ['activity', 'stats', 'notifications'],
    lastLogin: new Date().toISOString(),
    userId,
  };
}

function updateWidget(widgetId, config) {
  if (!widgetId) {
    throw new Error('Widget ID is required');
  }
  return { widgetId, config, updated: true };
}

module.exports = { getDashboardData, updateWidget };
