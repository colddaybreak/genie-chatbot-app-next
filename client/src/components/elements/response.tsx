import { type ComponentProps, memo } from 'react';
import { cjk } from '@streamdown/cjk';
import { ImageLinkAnchor } from './image-link';
import { Streamdown } from 'streamdown';

type ResponseProps = ComponentProps<typeof Streamdown>;

// 提到模块顶层，保证引用稳定，避免每次渲染创建新对象
const streamdownComponents = {
  a: ImageLinkAnchor,
};

const streamdownPlugins = {
  cjk,
};

export const Response = memo(
  (props: ResponseProps) => {
    return (
      <Streamdown
        components={streamdownComponents}
        plugins={streamdownPlugins}
        className="flex flex-col gap-4"
        {...props}
      />
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = 'Response';