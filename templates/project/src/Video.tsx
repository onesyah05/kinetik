import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

export const Video: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const enter = spring({frame, fps, config: {damping: 200}});
  const opacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{backgroundColor: '#0f1115', justifyContent: 'center', alignItems: 'center'}}>
      <div
        style={{
          color: 'white',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: width * 0.06,
          fontWeight: 700,
          opacity,
          transform: `translateY(${(1 - enter) * 40}px)`,
        }}
      >
        Describe your video in the chat
      </div>
    </AbsoluteFill>
  );
};
