import React from 'react';
import { Icon } from "@/components/icon/Icon";
import { TodoProgressMark } from '@/components/chat/todo/TodoList';
import { cn } from '@/lib/utils';
import { toolIconSpec } from './toolIconModel';

export const getToolIcon = (toolName: string) => {
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    const spec = toolIconSpec(toolName);
    if (spec.todo) {
        return <TodoProgressMark className={cn('size-3.5 text-current', iconClass)} />;
    }
    return <Icon name={spec.name} className={spec.size === 13 ? 'h-[13px] w-[13px] flex-shrink-0' : iconClass} />;
};
