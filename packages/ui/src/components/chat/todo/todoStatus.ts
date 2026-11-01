export type TodoStatus = 'in_progress' | 'pending' | 'completed' | 'cancelled';

export type TodoListItem = {
  id?: string;
  content: string;
  status: string;
};

export const toTodoStatus = (value: string): TodoStatus => (
  value === 'in_progress' || value === 'completed' || value === 'cancelled' ? value : 'pending'
);

export const isTodoFinished = (todo: TodoListItem): boolean => (
  todo.status === 'completed' || todo.status === 'cancelled'
);
