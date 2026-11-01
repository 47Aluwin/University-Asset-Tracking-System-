import { Stack } from 'expo-router';
import { View } from 'react-native';

import { WebNav } from '@/components/web-nav';
import { useHeaderOptions } from '@/hooks/use-header-options';

export default function AppLayout() {
  const headerOptions = useHeaderOptions();
  return (
    <View style={{ flex: 1 }}>
      {/* Website menu bar (renders nothing on phones). */}
      <WebNav />
      <Stack screenOptions={headerOptions}>
        <Stack.Screen name='index' options={{ title: 'Asset Tracking' }} />
        <Stack.Screen name='account' options={{ title: 'My account' }} />
        <Stack.Screen name='assistant' options={{ title: 'Help assistant' }} />
        <Stack.Screen name='inventory/index' options={{ title: 'Assets' }} />
        <Stack.Screen
          name='inventory/new'
          options={{ title: 'Register asset' }}
        />
        <Stack.Screen name='inventory/find' options={{ title: 'Find asset' }} />
        <Stack.Screen
          name='inventory/[id]/index'
          options={{ title: 'Asset' }}
        />
        <Stack.Screen
          name='inventory/[id]/edit'
          options={{ title: 'Edit asset' }}
        />
        <Stack.Screen
          name='inventory/[id]/label'
          options={{ title: 'QR label' }}
        />
        <Stack.Screen
          name='inventory/[id]/verify'
          options={{ title: 'Verify asset' }}
        />
        <Stack.Screen
          name='inventory/[id]/move'
          options={{ title: 'Relocate asset' }}
        />
        <Stack.Screen
          name='inventory/[id]/condition'
          options={{ title: 'Condition' }}
        />
        <Stack.Screen
          name='maintenance/index'
          options={{ title: 'Maintenance' }}
        />
        <Stack.Screen
          name='maintenance/new'
          options={{ title: 'Request maintenance' }}
        />
        <Stack.Screen
          name='maintenance/[id]'
          options={{ title: 'Maintenance request' }}
        />
        <Stack.Screen name='dashboard' options={{ title: 'Dashboard' }} />
        <Stack.Screen name='sync' options={{ title: 'Waiting to sync' }} />
        <Stack.Screen
          name='asset-reviews'
          options={{ title: 'Registration review' }}
        />
        <Stack.Screen name='offline-label' options={{ title: 'QR label' }} />
        <Stack.Screen name='reports' options={{ title: 'Reports' }} />
        <Stack.Screen name='scan' options={{ title: 'Scan asset' }} />
        <Stack.Screen name='review' options={{ title: 'Review flags' }} />
        <Stack.Screen
          name='admin/schedules'
          options={{ title: 'Verification schedules' }}
        />
        <Stack.Screen
          name='admin/access-requests'
          options={{ title: 'Access requests' }}
        />
        <Stack.Screen name='admin/users/index' options={{ title: 'Users' }} />
        <Stack.Screen name='admin/users/new' options={{ title: 'New user' }} />
        <Stack.Screen name='admin/users/[id]' options={{ title: 'User' }} />
        <Stack.Screen
          name='admin/departments'
          options={{ title: 'Faculties and departments' }}
        />
        <Stack.Screen
          name='admin/categories'
          options={{ title: 'Categories' }}
        />
        <Stack.Screen
          name='admin/label-layout'
          options={{ title: 'Label layout' }}
        />
        <Stack.Screen name='admin/audit' options={{ title: 'Audit log' }} />
      </Stack>
    </View>
  );
}
