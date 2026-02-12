const { getDashboardData, updateWidget } = require('../src/dashboard/dashboard');

describe('dashboard', () => {
  test('getDashboardData returns widgets', () => {
    const data = getDashboardData('user-1');
    expect(data.widgets).toHaveLength(3);
    expect(data.userId).toBe('user-1');
  });

  test('getDashboardData requires userId', () => {
    expect(() => getDashboardData()).toThrow('User ID is required');
  });

  test('updateWidget succeeds', () => {
    const result = updateWidget('widget-1', { size: 'large' });
    expect(result.updated).toBe(true);
    expect(result.widgetId).toBe('widget-1');
  });

  test('updateWidget requires widgetId', () => {
    expect(() => updateWidget()).toThrow('Widget ID is required');
  });
});
