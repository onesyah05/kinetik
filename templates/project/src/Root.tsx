// Managed by Kinetik. Do not edit.
// Size/fps/duration/captions come from project.json, passed in as props at render time.
import React from 'react';
import {Composition} from 'remotion';
import {KitRoot, type ProjectSettings} from '@kit';
import project from '../project.json';
import {Video} from './Video';

const Main: React.FC<{settings: ProjectSettings}> = ({settings}) => (
  <KitRoot settings={settings}>
    <Video />
  </KitRoot>
);

export const Root: React.FC = () => (
  <Composition
    id="main"
    component={Main}
    width={project.width}
    height={project.height}
    fps={project.fps}
    durationInFrames={project.durationInFrames}
    defaultProps={{settings: project as unknown as ProjectSettings}}
    calculateMetadata={({props}) => ({
      width: props.settings.width,
      height: props.settings.height,
      fps: props.settings.fps,
      durationInFrames: props.settings.durationInFrames,
    })}
  />
);
